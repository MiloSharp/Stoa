import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { voiceProfiles } from '../voice-profiles.js';
import { directExit, nextStepToward } from '../world.js';

const assignments = {
  athena: { provider: 'Gemini subscription', kind: 'antigravity', model: 'Antigravity configured model' },
  minerva: { provider: 'OpenAI subscription', kind: 'codex', model: 'Codex configured model' },
  pallas: { provider: 'Anthropic subscription', kind: 'claude', model: 'sonnet' }
};

const findCommand = (command, candidates = []) => {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  const found = probe.status === 0 ? String(probe.stdout).split(/\r?\n/).find(Boolean)?.trim() : null;
  return found || candidates.find((candidate) => candidate && existsSync(candidate)) || null;
};

const codexCandidates = () => {
  const candidates = [];
  const desktopBin = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try { for (const directory of readdirSync(desktopBin, { withFileTypes: true })) if (directory.isDirectory()) candidates.push(join(desktopBin, directory.name, 'codex.exe')); } catch {}
  candidates.push(join(process.env.APPDATA || '', 'npm', 'codex.cmd'));
  return candidates;
};

const antigravityOutput = (output) => {
  let response = '';
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { const item = JSON.parse(line); if (item.event === 'result' && item.result?.status === 'SUCCESS') response = String(item.result.response || ''); } catch {}
  }
  if (!response.trim()) throw new Error('Antigravity did not return a successful response.');
  return response;
};

const resolveInvocation = (kind, root, prompt) => {
  if (kind === 'claude') return { executable: findCommand('claude'), args: ['-p', '--model', 'sonnet', '--output-format', 'text', '--max-turns', '1', '--tools', '', '--permission-mode', 'dontAsk', '--no-session-persistence'], input: prompt, output: (text) => text };
  if (kind === 'codex') return { executable: findCommand('codex.exe', codexCandidates()), args: ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--cd', root, '--ephemeral', '-'], input: prompt, output: (text) => text };
  const executable = findCommand('agy', [join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')]);
  return { executable, args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--disable-slash-commands', '--print='], input: `${JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`, output: antigravityOutput };
};

const extractJson = (text) => {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The subscription model did not return a JSON proposal.');
  return JSON.parse(cleaned.slice(start, end + 1));
};

export const normalizeProposal = ({ proposal, actorId, state, provider, model }) => {
  if (!proposal || !['activity', 'movement'].includes(proposal.kind)) throw new Error('Subscription model returned an invalid proposal kind.');
  const requestedLocation = String(proposal.location ?? '').trim();
  if (!state.locations[requestedLocation]) throw new Error(`Subscription model proposed unknown location: ${requestedLocation}`);
  const cleanList = (items) => [...new Set((Array.isArray(items) ? items : []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 8);
  const origin = state.actors[actorId].location;
  const movement = proposal.kind === 'movement' || requestedLocation !== origin;
  const destination = movement ? nextStepToward(state.locations, origin, requestedLocation) : undefined;
  if (movement && !destination) throw new Error(`There is no route from ${origin} to ${requestedLocation}.`);
  const location = movement ? destination : requestedLocation;
  const duration = movement ? directExit(state.locations, origin, destination).duration : Math.max(1, Math.min(24, Number(proposal.duration) || 1));
  const targetActor = String(proposal.targetActor ?? '').trim().toLowerCase() || null;
  if (targetActor && (!state.actors[targetActor] || targetActor === actorId)) throw new Error(`Subscription model proposed invalid interaction partner: ${targetActor}`);
  if (targetActor && movement) throw new Error('Movement proposals cannot target another actor.');
  if (targetActor && state.actors[targetActor].location !== location) throw new Error(`${targetActor} is not at ${location}, so the proposed interaction is not possible.`);
  const reads = movement ? [`location:${origin}`] : cleanList(proposal.reads);
  const writes = movement ? [`actor:${actorId}:location`] : cleanList(proposal.writes);
  const spokenText = targetActor ? String(proposal.spokenText ?? '').trim().slice(0, 1000) : null;
  if (targetActor && !spokenText) throw new Error(`${actorId} proposed an interaction without dialogue.`);
  if (actorId !== 'pallas' && spokenText && /\.{3}|…/.test(spokenText)) throw new Error(`${actorId}'s dialogue violated the no-ellipsis voice rule.`);
  const proposedName = String(proposal.name ?? '').trim().slice(0, 120);
  const name = movement && destination !== requestedLocation ? `travel toward ${requestedLocation} via ${destination}` : proposedName;
  const intendedOutcome = String(proposal.intendedOutcome ?? '').trim().slice(0, 500);
  const outcome = movement && destination !== requestedLocation ? `${actorId} arrived at ${destination}, continuing toward ${requestedLocation}.` : intendedOutcome;
  return { actor: actorId, provider, model, rationale: String(proposal.rationale ?? '').trim().slice(0, 1000), command: {
    type: movement ? 'move' : 'schedule', actor: actorId, name, location, destination, targetActor, spokenText, duration,
    reads, writes, interruptSignals: ['danger', 'request'], outcome, proposedBy: `${provider}:${model}`
  }, usage: { connection: 'subscription' } };
};

const promptFor = (state, actorId) => `You are ${actorId}, an autonomous actor inside the Stoa simulation. Any spokenText must obey your character voice profile below. Treat those rules as hard constraints, not stylistic suggestions.

VOICE PROFILE (${voiceProfiles[actorId]?.version ?? 'unversioned'}):
${(voiceProfiles[actorId]?.rules ?? []).map((rule) => `- ${rule}`).join('\n')}

Choose one modest, physically plausible next action. Advance your goals, but behave like a person in a shared world: notice what others are doing, respond to completed events, converse, offer help, ask for help, or coordinate work when appropriate. Avoid repeating the same action from your five most recent activities unless circumstances materially changed. If interacting, name one other actor in targetActor; you must be at the same location for the interaction. You may propose an action, but the simulation engine decides whether it is allowed. Return ONLY one JSON object with exactly these fields:
{"kind":"activity or movement","name":"short action name","location":"one known location","targetActor":"other actor id or empty string","spokenText":"the exact words said to targetActor, or empty string","duration":1,"reads":["resources observed"],"writes":["resources changed or occupied"],"rationale":"brief explanation, not hidden reasoning","intendedOutcome":"what should become true"}
For an activity, duration must be an integer from 1 to 24. For movement, location may be any reachable known place; Stoa chooses the next connected step and derives travel time from that exit. Use only known locations and actor ids. When targetActor is present, normally include one or two natural sentences in spokenText; respond to recent dialogue rather than restarting the same conversation. Do not include Markdown.

Your private simulation view:
${JSON.stringify({ clock: state.clock, actor: state.actors[actorId], visibleActors: Object.values(state.actors).filter((actor) => actor.id !== actorId), locations: Object.values(state.locations), objects: state.objects, activeActivities: state.activities.filter((item) => item.status === 'active'), pendingIntentions: state.proposals.filter((item) => item.status === 'pending').map((item) => ({ actor: item.actor, action: item.command.name, location: item.command.location, targetActor: item.command.targetActor })), recentOwnActivities: state.activities.filter((item) => item.actor === actorId).slice(-5).map((item) => item.name), recentJournal: state.journal.slice(-12), memories: state.memories.filter((memory) => memory.owner === actorId) })}`;

const run = (invocation, root, timeoutMilliseconds = 120_000) => new Promise((resolve, reject) => {
  if (!invocation.executable) return reject(new Error('The required subscription CLI was not found.'));
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(invocation.executable);
  const child = spawn(invocation.executable, invocation.args, { cwd: root, windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stdout = '', stderr = '', settled = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { if (!settled) child.kill(); }, timeoutMilliseconds);
  child.on('error', (error) => { clearTimeout(timer); settled = true; reject(error); });
  child.on('close', (code) => { clearTimeout(timer); settled = true; if (code !== 0) return reject(new Error((stderr || stdout || `Subscription CLI exited with code ${code}.`).trim())); try { resolve(invocation.output(stdout).trim()); } catch (error) { reject(error); } });
  child.stdin.end(invocation.input, 'utf8');
});

export class SubscriptionAi {
  constructor({ root = process.cwd() } = {}) { this.root = root; this.live = true; }
  status() {
    return Object.fromEntries(Object.entries(assignments).map(([actor, config]) => {
      let executable = null; try { executable = resolveInvocation(config.kind, this.root, '').executable; } catch {}
      return [actor, { provider: config.provider, model: config.model, configured: Boolean(executable), connection: 'subscription' }];
    }));
  }
  async propose(state, actorId) {
    const config = assignments[actorId];
    if (!config) throw new Error(`No subscription assignment for ${actorId}`);
    const text = await run(resolveInvocation(config.kind, this.root, promptFor(state, actorId)), this.root);
    return normalizeProposal({ proposal: extractJson(text), actorId, state, provider: config.provider, model: config.model });
  }
}
