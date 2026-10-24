import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StoaEngine } from './engine.js';
import { PostgresStore } from './store.js';
import { createProvider, SubscriptionAi } from './providers/index.js';
import { AutonomyController } from './autonomy.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. See .env.example.');

const store = await PostgresStore.connect(process.env.DATABASE_URL);
let activeRunId = process.env.SIMULATION_ID ?? 'local';
let engine = await new StoaEngine({ store, simulationId: activeRunId }).initialize();
const provider = createProvider('mock');
const ai = new SubscriptionAi({ root: fileURLToPath(new URL('..', import.meta.url)) });
const providerActivity = new Map();
let aiRunState = { state: 'idle', cycle: 0, total: 0 };
let autoPromptOnCompletion = true;
const autonomy = () => new AutonomyController({ engine, provider });
const dashboard = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);

const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
const readBody = async (request) => {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 1_000_000) throw new Error('request too large'); }
  return text ? JSON.parse(text) : {};
};

const createAiProposal = async (actor) => {
  if (providerActivity.get(actor)?.state === 'thinking') throw new Error(`${actor} is already thinking`);
  providerActivity.set(actor, { state: 'thinking', since: new Date().toISOString() });
  try {
    const proposal = await ai.propose(engine.view(actor), actor);
    const created = await engine.submit({ type: 'proposal.create', proposal });
    if (!created.ok) throw new Error(created.reason);
    providerActivity.set(actor, { state: 'ready', message: proposal.command.name });
    return created.events[0].proposal;
  } catch (error) { providerActivity.set(actor, { state: 'error', message: error.message }); throw error; }
};

const requestCompletionFollowups = (events = []) => {
  if (!autoPromptOnCompletion || aiRunState.state === 'running') return;
  const actors = [...new Set(events.filter((event) => event.type === 'activity.completed').map((event) => event.actor))];
  for (const actor of actors) {
    const snapshot = engine.snapshot();
    const available = snapshot.actors[actor]?.status === 'idle';
    const pending = snapshot.proposals.some((proposal) => proposal.actor === actor && proposal.status === 'pending');
    if (!available || pending || providerActivity.get(actor)?.state === 'thinking') continue;
    setTimeout(() => { void createAiProposal(actor).catch(() => {}); }, 0);
  }
};

const resolvePendingProposal = async (proposal, action = 'approve') => {
  if (action === 'reject') {
    const result = await engine.submit({ type: 'proposal.resolve', proposalId: proposal.id, resolution: 'rejected' });
    providerActivity.delete(proposal.actor); return result;
  }
  const applied = await engine.submit({ ...proposal.command, expectedVersion: engine.snapshot().version });
  await engine.submit({ type: 'proposal.resolve', proposalId: proposal.id, resolution: applied.ok ? 'approved' : 'failed', reason: applied.reason });
  providerActivity.delete(proposal.actor); return applied;
};

const runAiCycles = async ({ maxCycles = 3, autoApprove = true } = {}) => {
  if (aiRunState.state === 'running') throw new Error('Subscription AI cycles are already running.');
  const limit = Math.max(1, Math.min(10, Number(maxCycles) || 3));
  aiRunState = { state: 'running', cycle: 0, total: limit };
  const results = [];
  try {
    for (let cycle = 1; cycle <= limit; cycle += 1) {
      aiRunState = { state: 'running', cycle, total: limit };
      const snapshot = engine.snapshot();
      const actors = Object.values(snapshot.actors).filter((actor) => actor.status === 'idle' && !snapshot.proposals.some((proposal) => proposal.actor === actor.id && proposal.status === 'pending')).map((actor) => actor.id);
      const generated = await Promise.allSettled(actors.map((actor) => createAiProposal(actor)));
      const cycleResult = { cycle, generated: generated.map((item, index) => item.status === 'fulfilled' ? { actor: actors[index], ok: true } : { actor: actors[index], ok: false, reason: item.reason.message }), approvals: [] };
      if (!autoApprove) { results.push(cycleResult); break; }
      for (const proposal of engine.snapshot().proposals.filter((item) => item.status === 'pending')) {
        const applied = await resolvePendingProposal(proposal, 'approve');
        cycleResult.approvals.push({ actor: proposal.actor, ok: applied.ok, reason: applied.reason ?? null });
      }
      const active = engine.snapshot().activities.filter((activity) => activity.status === 'active');
      if (active.length) {
        const nextAt = Math.min(...active.map((activity) => activity.endAt));
        await engine.submit({ type: 'advance', amount: Math.max(1, nextAt - engine.snapshot().clock) });
      }
      results.push(cycleResult);
      if (!active.length && !cycleResult.approvals.some((item) => item.ok)) break;
    }
    return { ok: true, cycles: results.length, results, state: engine.snapshot() };
  } finally { aiRunState = { state: 'idle', cycle: 0, total: 0 }; }
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? host}`);
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end(dashboard); }
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, engine.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/runs') return json(response, 200, { activeRunId, runs: await store.listRuns() });
    if (request.method === 'GET' && url.pathname === '/api/providers') {
      const actors = ai.status(); for (const [actor, activity] of providerActivity) actors[actor].activity = activity;
      return json(response, 200, { approvalMode: true, autoPromptOnCompletion, actors, run: aiRunState });
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/auto-prompt') {
      const body = await readBody(request); autoPromptOnCompletion = Boolean(body.enabled);
      return json(response, 200, { ok: true, autoPromptOnCompletion });
    }
    if (request.method === 'POST' && url.pathname === '/api/runs') {
      const body = await readBody(request); const id = String(body.id ?? '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) return json(response, 400, { error: 'run name must use letters, numbers, hyphens, or underscores' });
      engine = await new StoaEngine({ store, simulationId: id }).initialize(); activeRunId = id;
      if (body.scenario) { const result = await engine.submit({ type: 'scenario.load', scenario: body.scenario }); if (!result.ok) return json(response, 409, result); }
      else await engine.submit({ type: 'set', actor: 'system', target: 'run_created', value: true });
      return json(response, 201, { ok: true, activeRunId, state: engine.snapshot() });
    }
    if (request.method === 'POST' && url.pathname === '/api/runs/select') {
      const body = await readBody(request); activeRunId = String(body.id); engine = await new StoaEngine({ store, simulationId: activeRunId }).initialize();
      return json(response, 200, { ok: true, activeRunId, state: engine.snapshot() });
    }
    if (request.method === 'POST' && url.pathname === '/api/runs/reset') {
      await store.reset(activeRunId); engine = await new StoaEngine({ store, simulationId: activeRunId }).initialize();
      await engine.submit({ type: 'set', actor: 'system', target: 'run_created', value: true });
      return json(response, 200, { ok: true, activeRunId, state: engine.snapshot() });
    }
    if (request.method === 'POST' && url.pathname === '/api/mock/propose') {
      const body = await readBody(request); const proposal = provider.propose(engine.snapshot(), body.actor);
      return proposal ? json(response, 200, { ok: true, proposal }) : json(response, 409, { ok: false, reason: 'actor unavailable' });
    }
    if (request.method === 'POST' && url.pathname === '/api/autonomy/cycle') return json(response, 200, await autonomy().cycle());
    if (request.method === 'POST' && url.pathname === '/api/autonomy/run') {
      const body = await readBody(request); return json(response, 200, await autonomy().run({ maxCycles: body.maxCycles }));
    }
    if (request.method === 'POST' && url.pathname === '/api/ai/propose') {
      const body = await readBody(request); const proposal = await createAiProposal(String(body.actor));
      return json(response, 201, { ok: true, proposal });
    }
    if (request.method === 'POST' && url.pathname === '/api/ai/run') {
      const body = await readBody(request); return json(response, 200, await runAiCycles({ maxCycles: body.maxCycles, autoApprove: body.autoApprove !== false }));
    }
    const proposalMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
    if (request.method === 'POST' && proposalMatch) {
      const [, proposalId, action] = proposalMatch; const proposal = engine.snapshot().proposals.find((item) => item.id === proposalId && item.status === 'pending');
      if (!proposal) return json(response, 404, { error: 'pending proposal not found' });
      if (action === 'reject') return json(response, 200, await resolvePendingProposal(proposal, 'reject'));
      const applied = await resolvePendingProposal(proposal, 'approve');
      return json(response, applied.ok ? 200 : 409, applied);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/view/')) return json(response, 200, engine.view(decodeURIComponent(url.pathname.slice(10))));
    if (request.method === 'POST' && url.pathname === '/api/commands') {
      const result = await engine.submit(await readBody(request));
      if (result.ok) requestCompletionFollowups(result.events);
      return json(response, result.ok ? 200 : 409, result);
    }
    return json(response, 404, { error: 'not found' });
  } catch (error) { return json(response, 400, { error: error.message }); }
});

server.listen(port, host, () => console.log(`Stoa dashboard: http://${host}:${port}`));
const shutdown = async () => { server.close(); await store.close(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
