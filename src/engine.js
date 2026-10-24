import { randomUUID } from 'node:crypto';
import { findConflicts } from './conflicts.js';
import { directExit, normalizeTopology, topologyError } from './world.js';

const defaultGoals = {
  athena: [
    { id: 'understand-archive', description: 'Understand the records in the Archive', priority: 80, steps: [{ id: 'study', name: 'study the archive', location: 'Archive', duration: 3, reads: ['archive'], writes: ['notes:athena'], effects: { 'archive-study': 'complete' }, outcome: 'Athena completed a study of the archive.' }] },
    { id: 'maintain-knowledge', description: 'Keep the shared record current', priority: 30, repeat: true, steps: [{ id: 'catalogue', name: 'catalogue recent observations', location: 'Archive', duration: 3, reads: ['notes:pallas', 'notes:minerva'], writes: ['catalogue'], effects: { catalogue: 'updated' }, outcome: 'Athena brought the shared catalogue up to date.' }] }
  ],
  minerva: [
    { id: 'weave-cloth', description: 'Weave a finished cloth', priority: 90, steps: [{ id: 'weave', name: 'weave cloth on the loom', location: 'Agora', duration: 4, reads: ['pattern'], writes: ['loom'], startEffects: { loom: { status: 'occupied', user: 'minerva' }, cloth: { status: 'in progress' } }, cancelEffects: { loom: { status: 'available' }, cloth: { status: 'unfinished' } }, effects: { loom: { status: 'available' }, cloth: { status: 'complete', maker: 'minerva' } }, outcome: 'Minerva finished weaving the cloth.' }] },
    { id: 'practice-craft', description: 'Maintain and refine the weaving craft', priority: 30, repeat: true, steps: [{ id: 'refine', name: 'refine a weaving pattern', location: 'Agora', duration: 2, reads: ['cloth'], writes: ['pattern'], effects: { pattern: 'refined' }, outcome: 'Minerva refined the next weaving pattern.' }] }
  ],
  pallas: [
    { id: 'tend-garden', description: 'Inspect and tend the South Garden', priority: 70, steps: [{ id: 'inspect', name: 'inspect the garden beds', location: 'South Garden', duration: 2, reads: ['garden'], writes: ['notes:pallas'], effects: { 'garden-inspection': 'complete' }, outcome: 'Pallas completed the garden inspection.' }] },
    { id: 'watch-garden', description: 'Keep watch over the changing garden', priority: 30, repeat: true, steps: [{ id: 'tend', name: 'tend the garden beds', location: 'South Garden', duration: 2, reads: ['garden'], writes: ['notes:pallas'], effects: { garden: 'tended' }, outcome: 'Pallas tended the garden and noted what had changed.' }] }
  ]
};
const defaultActors = () => Object.fromEntries(['athena', 'minerva', 'pallas'].map((id) => [id, {
  id, status: 'idle', activityId: null, activity: 'idle', location: 'Agora', sinceAt: 0, untilAt: null,
  goals: structuredClone(defaultGoals[id]), currentGoal: null, lastDecision: null
}]));
const defaultLocations = () => ({
  Agora: { name: 'Agora', description: 'The shared central space.', exits: { Archive: { duration: 1 }, 'South Garden': { duration: 1 } } },
  Archive: { name: 'Archive', description: 'Records and study materials.', exits: { Agora: { duration: 1 } } },
  'South Garden': { name: 'South Garden', description: 'A cultivated outdoor area.', exits: { Agora: { duration: 1 } } }
});
const freshState = () => ({ clock: 0, version: 0, sequence: 0, paused: false, scenario: 'default', objects: {}, locations: defaultLocations(), actors: defaultActors(), activities: [], events: [], memories: [], journal: [], proposals: [], autonomy: { cycles: 0, decisions: [] } });

export class StoaEngine {
  constructor({ store, simulationId = 'default' }) { this.store = store; this.simulationId = simulationId; this.state = freshState(); this._queue = Promise.resolve(); }
  async initialize() {
    await this.store.initialize();
    const loaded = await this.store.load(this.simulationId);
    this.state = loaded.snapshot ?? freshState();
    this.state.actors ??= defaultActors();
    this.state.locations ??= defaultLocations();
    const defaultWorld = defaultLocations();
    if (this.state.scenario === 'default' && Object.keys(defaultWorld).every((name) => this.state.locations[name])) {
      for (const [name, location] of Object.entries(defaultWorld)) this.state.locations[name].exits ??= structuredClone(location.exits);
    }
    this.state.locations = normalizeTopology(this.state.locations, { legacyComplete: true });
    this.state.journal ??= [];
    this.state.autonomy ??= { cycles: 0, decisions: [] };
    this.state.proposals ??= [];
    const defaults = defaultActors();
    for (const [id, actor] of Object.entries(this.state.actors)) {
      actor.goals ??= [];
      for (const goal of defaults[id]?.goals ?? []) {
        if (!actor.goals.some((existing) => existing.id === goal.id)) actor.goals.push(structuredClone(goal));
      }
      actor.currentGoal ??= null;
      actor.lastDecision ??= null;
    }
    for (const event of loaded.events) this.#apply(event);
    for (const activity of this.state.activities.filter((item) => item.status === 'active' || item.status === 'paused')) {
      activity.writes ??= [];
      if (!activity.writes.includes(`actor:${activity.actor}:attention`)) activity.writes.push(`actor:${activity.actor}:attention`);
      if (activity.targetActor && !activity.writes.includes(`actor:${activity.targetActor}:attention`)) activity.writes.push(`actor:${activity.targetActor}:attention`);
      this.state.actors[activity.actor] ??= { id: activity.actor, location: 'unspecified' };
      Object.assign(this.state.actors[activity.actor], { status: activity.status, activityId: activity.id, activity: activity.name,
        location: activity.kind === 'movement' ? this.state.actors[activity.actor].location : activity.location ?? this.state.actors[activity.actor].location ?? 'unspecified',
        sinceAt: activity.startAt, untilAt: activity.status === 'active' ? activity.endAt : null });
    }
    return this;
  }
  snapshot() { return structuredClone(this.state); }
  view(actor) {
    const state = this.snapshot();
    state.events = state.events.filter((e) => e.visibility === 'shared' || e.actor === actor);
    state.memories = state.memories.filter((m) => m.owner === actor);
    return state;
  }
  submit(command) {
    const run = () => this.#submit(command);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }
  async #submit(command) {
    if (command.expectedVersion !== undefined && command.expectedVersion !== this.state.version) {
      // Schedules may be safely rebased when their declared resources remain independent.
      if (command.type !== 'schedule' || command.expectedVersion > this.state.version)
        return { ok: false, reason: 'stale world version', version: this.state.version };
    }
    if (this.state.paused && !['resume', 'interrupt', 'activity.resume', 'activity.cancel'].includes(command.type)) return { ok: false, reason: 'simulation paused' };
    const draft = this.snapshot();
    const emitted = this.#decide(command, draft);
    if (!emitted.ok) return emitted;
    for (const event of emitted.events) this.#applyTo(draft, event);
    draft.version += 1;
    await this.store.commit(this.simulationId, emitted.events, draft);
    this.state = draft;
    return { ok: true, events: structuredClone(emitted.events), version: draft.version };
  }
  #event(type, data = {}) { return { id: randomUUID(), sequence: ++this.state.sequence, type, simulatedAt: this.state.clock, visibility: 'shared', ...data }; }
  #decide(command, draft) {
    // sequence is restored if validation rejects the proposal.
    const sequenceBefore = this.state.sequence;
    let events = [];
    if (command.type === 'scenario.load') {
      if (draft.version !== 0 || draft.events.length) return { ok: false, reason: 'scenario can only be loaded into a new run' };
      if (!command.scenario || !Array.isArray(command.scenario.actors) || !Array.isArray(command.scenario.locations)) return { ok: false, reason: 'invalid scenario' };
      const rawLocations = Object.fromEntries(command.scenario.locations.map((location) => [location.name, location]));
      const locations = normalizeTopology(rawLocations, { legacyComplete: true });
      const invalidTopology = topologyError(locations);
      if (invalidTopology) return { ok: false, reason: invalidTopology };
      if (command.scenario.actors.some((actor) => actor.location && !locations[actor.location])) return { ok: false, reason: 'actor has unknown location' };
      events = [this.#event('scenario.loaded', { scenario: { ...structuredClone(command.scenario), locations: Object.values(locations) } })];
    } else if (command.type === 'schedule' || command.type === 'move') {
      if (!command.actor || !command.name || !draft.actors?.[command.actor]) return { ok: false, reason: 'invalid activity' };
      const destination = command.type === 'move' ? command.destination?.trim() : null;
      if (destination && !draft.locations[destination]) return { ok: false, reason: 'unknown destination' };
      const origin = draft.actors[command.actor].location;
      const activityLocation = command.type === 'move' ? origin : command.location?.trim() || origin;
      if (!draft.locations[activityLocation]) return { ok: false, reason: 'unknown activity location' };
      const exit = destination ? directExit(draft.locations, origin, destination) : null;
      if (command.type === 'move' && origin === destination) return { ok: false, reason: 'actor is already at destination' };
      if (command.type === 'move' && !exit) return { ok: false, reason: `no direct exit from ${origin} to ${destination || 'the requested destination'}` };
      const duration = command.type === 'move' ? exit.duration : Number(command.duration);
      if (!Number.isInteger(duration) || duration <= 0) return { ok: false, reason: 'invalid activity' };
      const targetActor = command.targetActor?.trim() || null;
      if (targetActor && (!draft.actors[targetActor] || targetActor === command.actor)) return { ok: false, reason: 'invalid interaction partner' };
      if (targetActor && draft.actors[targetActor].location !== activityLocation) return { ok: false, reason: 'interaction partner is elsewhere' };
      if (command.type === 'schedule' && activityLocation !== origin) return { ok: false, reason: 'actor is not at activity location' };
      const reads = [...new Set(command.reads ?? [])];
      const writes = [...new Set([...(command.writes ?? []), `actor:${command.actor}:attention`, ...(targetActor ? [`actor:${targetActor}:attention`] : [])])];
      const activity = { id: command.id ?? randomUUID(), actor: command.actor, name: command.name,
        startAt: draft.clock, endAt: draft.clock + duration, reads, writes,
        interruptSignals: [...new Set(command.interruptSignals ?? ['danger'])], location: activityLocation,
        kind: command.type === 'move' ? 'movement' : 'activity', destination, startEffects: structuredClone(command.startEffects ?? {}), cancelEffects: structuredClone(command.cancelEffects ?? {}),
        goalId: command.goalId ?? null, stepId: command.stepId ?? null, proposedBy: command.proposedBy ?? 'user', targetActor,
        spokenText: targetActor ? command.spokenText?.trim()?.slice(0, 1000) || null : null,
        effects: structuredClone(command.effects ?? {}), outcome: command.outcome?.trim() || null, status: 'active' };
      const conflicts = findConflicts(activity, draft.activities.filter((x) => x.status === 'active'));
      if (conflicts.length) return { ok: false, reason: 'resource conflict', conflicts: conflicts.map((x) => x.id) };
      events = [this.#event('activity.scheduled', { actor: command.actor, activity })];
    } else if (command.type === 'advance') {
      const amount = Number(command.amount);
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'invalid time advance' };
      const target = draft.clock + amount;
      const completing = draft.activities.filter((x) => x.status === 'active' && x.endAt <= target).sort((a,b) => a.endAt-b.endAt || a.id.localeCompare(b.id));
      for (const activity of completing) events.push(this.#event('activity.completed', { actor: activity.actor, simulatedAt: activity.endAt, activityId: activity.id,
        effects: command.effects?.[activity.id] ?? activity.effects ?? {}, destination: activity.destination, outcome: activity.outcome,
        targetActor: activity.targetActor, spokenText: activity.spokenText }));
      events.push(this.#event('time.advanced', { simulatedAt: target, from: draft.clock, to: target }));
    } else if (command.type === 'interrupt') {
      const targets = draft.activities.filter((x) => x.status === 'active' && (!command.actor || x.actor === command.actor) && x.interruptSignals.includes(command.signal));
      if (!targets.length) return { ok: false, reason: 'no interruptible activity' };
      const mode = command.mode ?? 'cancel';
      if (!['cancel', 'pause', 'reschedule'].includes(mode)) return { ok: false, reason: 'invalid interrupt mode' };
      events = targets.map((activity) => this.#event('activity.interrupted', { actor: activity.actor, activityId: activity.id, signal: command.signal, mode, remaining: Math.max(0, activity.endAt - draft.clock) }));
    } else if (command.type === 'activity.resume' || command.type === 'activity.cancel') {
      const activity = draft.activities.find((item) => item.id === command.activityId && item.status === 'paused');
      if (!activity) return { ok: false, reason: 'paused activity not found' };
      events = [this.#event(command.type === 'activity.resume' ? 'activity.resumed' : 'activity.cancelled', { actor: activity.actor, activityId: activity.id, remaining: activity.remaining ?? 1 })];
    } else if (command.type === 'autonomy.decision') {
      if (!command.decision?.actor) return { ok: false, reason: 'invalid autonomy decision' };
      events = [this.#event('autonomy.decided', { actor: command.decision.actor, decision: structuredClone(command.decision) })];
    } else if (command.type === 'proposal.create') {
      if (!command.proposal?.actor || !command.proposal?.command) return { ok: false, reason: 'invalid proposal' };
      events = [this.#event('proposal.created', { actor: command.proposal.actor, proposal: { id: command.proposal.id ?? randomUUID(), status: 'pending', createdAt: draft.clock, ...structuredClone(command.proposal) } })];
    } else if (command.type === 'proposal.resolve') {
      const proposal = draft.proposals.find((item) => item.id === command.proposalId && item.status === 'pending');
      if (!proposal || !['approved', 'rejected', 'failed'].includes(command.resolution)) return { ok: false, reason: 'pending proposal not found or invalid resolution' };
      events = [this.#event('proposal.resolved', { actor: proposal.actor, proposalId: proposal.id, resolution: command.resolution, reason: command.reason ?? null })];
    } else if (command.type === 'pause' || command.type === 'resume') events = [this.#event(`simulation.${command.type}`)];
    else if (command.type === 'set') events = [this.#event('world.set', { actor: command.actor, target: command.target, value: command.value, visibility: command.visibility ?? 'shared' })];
    else if (command.type === 'remember') events = [this.#event('memory.recorded', { actor: command.actor, owner: command.actor, content: command.content, visibility: 'private' })];
    else return { ok: false, reason: 'unknown command' };
    this.state.sequence = sequenceBefore;
    // Allocate stable consecutive sequences without mutating accepted state before persistence succeeds.
    events = events.map((e, i) => ({ ...e, sequence: sequenceBefore + i + 1 }));
    return { ok: true, events };
  }
  #apply(event) { this.#applyTo(this.state, event); }
  #applyTo(state, event) {
    state.sequence = Math.max(state.sequence, event.sequence);
    state.clock = Math.max(state.clock, event.simulatedAt);
    if (event.type === 'scenario.loaded') {
      const scenario = event.scenario;
      state.scenario = scenario.name || 'untitled'; state.objects = structuredClone(scenario.objects ?? {});
      state.locations = Object.fromEntries(scenario.locations.map((location) => [location.name, structuredClone(location)]));
      state.actors = Object.fromEntries(scenario.actors.map((actor) => [actor.id, { id: actor.id, status: 'idle', activityId: null, activity: 'idle',
        location: actor.location || scenario.locations[0]?.name || 'unspecified', sinceAt: state.clock, untilAt: null,
        goals: structuredClone(actor.goals ?? defaultGoals[actor.id] ?? []), currentGoal: null, lastDecision: null }]));
    }
    if (event.type === 'activity.scheduled') {
      state.activities.push(structuredClone(event.activity));
      state.actors ??= defaultActors();
      state.actors[event.actor] ??= { id: event.actor, location: 'unspecified' };
      Object.assign(state.actors[event.actor], { status: 'active', activityId: event.activity.id, activity: event.activity.name,
        location: event.activity.kind === 'movement' ? state.actors[event.actor].location : event.activity.location,
        sinceAt: event.activity.startAt, untilAt: event.activity.endAt, currentGoal: event.activity.goalId });
      Object.assign(state.objects, event.activity.startEffects ?? {});
    }
    if (event.type === 'activity.completed') {
      const activity = state.activities.find((x) => x.id === event.activityId); if (activity) activity.status = 'completed';
      const actor = state.actors?.[event.actor];
      if (actor?.activityId === event.activityId) Object.assign(actor, { status: 'idle', activityId: null, activity: 'idle',
        location: event.destination || actor.location, sinceAt: event.simulatedAt, untilAt: null, currentGoal: null });
      Object.assign(state.objects, event.effects ?? {});
      const activityName = activity?.name ?? 'activity';
      state.journal ??= [];
      state.journal.push({ sequence: event.sequence, simulatedAt: event.simulatedAt, actor: event.actor,
        text: event.outcome || `${event.actor} completed ${activityName}${event.destination ? ` and arrived at ${event.destination}` : ''}.`, sourceEventId: event.id });
      if (event.spokenText && event.targetActor) state.journal.push({ sequence: event.sequence, simulatedAt: event.simulatedAt,
        actor: event.actor, targetActor: event.targetActor, kind: 'dialogue', spokenText: event.spokenText,
        text: `${event.actor} to ${event.targetActor}: “${event.spokenText}”`, sourceEventId: event.id });
    }
    if (event.type === 'activity.resumed') {
      const activity = state.activities.find((item) => item.id === event.activityId);
      if (activity) { activity.status = 'active'; activity.endAt = state.clock + event.remaining; }
      const actor = state.actors?.[event.actor]; if (actor) Object.assign(actor, { status: 'active', untilAt: state.clock + event.remaining, sinceAt: state.clock });
    }
    if (event.type === 'activity.cancelled') {
      const activity = state.activities.find((item) => item.id === event.activityId); if (activity) { activity.status = 'cancelled'; Object.assign(state.objects, activity.cancelEffects ?? {}); }
      const actor = state.actors?.[event.actor]; if (actor?.activityId === event.activityId) Object.assign(actor, { status: 'idle', activityId: null, activity: 'idle', sinceAt: state.clock, untilAt: null });
    }
    if (event.type === 'activity.interrupted') {
      const activity = state.activities.find((x) => x.id === event.activityId);
      if (activity) {
        activity.status = event.mode === 'pause' ? 'paused' : event.mode === 'reschedule' ? 'active' : 'cancelled';
        activity.remaining = event.remaining;
        if (event.mode === 'reschedule') activity.endAt = state.clock + event.remaining;
        if (event.mode === 'cancel') Object.assign(state.objects, activity.cancelEffects ?? {});
      }
      const actor = state.actors?.[event.actor];
      if (actor?.activityId === event.activityId) Object.assign(actor, event.mode === 'reschedule'
        ? { status: 'active', untilAt: state.clock + event.remaining }
        : { status: event.mode === 'pause' ? 'paused' : 'idle', activityId: event.mode === 'pause' ? event.activityId : null,
            activity: event.mode === 'pause' ? actor.activity : 'idle', sinceAt: state.clock, untilAt: null });
    }
    if (event.type === 'time.advanced') state.clock = event.to;
    if (event.type === 'simulation.pause') state.paused = true;
    if (event.type === 'simulation.resume') state.paused = false;
    if (event.type === 'world.set') state.objects[event.target] = event.value;
    if (event.type === 'memory.recorded') state.memories.push({ id: event.id, owner: event.owner, content: event.content, provenance: { eventId: event.id, simulatedAt: event.simulatedAt } });
    if (event.type === 'autonomy.decided') {
      state.autonomy ??= { cycles: 0, decisions: [] };
      state.autonomy.cycles += 1;
      state.autonomy.decisions.push({ ...structuredClone(event.decision), simulatedAt: event.simulatedAt, sequence: event.sequence });
      state.autonomy.decisions = state.autonomy.decisions.slice(-100);
      if (state.actors[event.actor]) state.actors[event.actor].lastDecision = structuredClone(event.decision);
    }
    if (event.type === 'proposal.created') state.proposals.push(structuredClone(event.proposal));
    if (event.type === 'proposal.resolved') {
      const proposal = state.proposals.find((item) => item.id === event.proposalId);
      if (proposal) Object.assign(proposal, { status: event.resolution, resolvedAt: event.simulatedAt, resolutionReason: event.reason });
    }
    state.events.push(event);
  }
}
