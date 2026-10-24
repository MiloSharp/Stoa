import test from 'node:test';
import assert from 'node:assert/strict';
import { StoaEngine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';

const make = async (store = new MemoryStore()) => new StoaEngine({ store, simulationId: 'test' }).initialize();

test('independent concurrent proposals rebase; conflicting work is rejected', async () => {
  const engine = await make();
  const version = engine.snapshot().version;
  const [first, second] = await Promise.all([
    engine.submit({ type: 'schedule', actor: 'athena', name: 'read', duration: 4, reads: ['archive'], writes: ['notes:a'], expectedVersion: version }),
    engine.submit({ type: 'schedule', actor: 'pallas', name: 'garden', duration: 3, reads: ['garden'], writes: ['notes:p'], expectedVersion: version })
  ]);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const conflict = await engine.submit({ type: 'schedule', actor: 'minerva', name: 'revise', duration: 2, writes: ['archive'], expectedVersion: version });
  assert.equal(conflict.ok, false); assert.equal(conflict.reason, 'resource conflict');
});

test('simulated time completes activities deterministically', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'athena', name: 'work', duration: 2, writes: ['result'] });
  await engine.submit({ type: 'advance', amount: 1 });
  assert.equal(engine.snapshot().activities[0].status, 'active');
  assert.equal(engine.snapshot().actors.athena.activity, 'work');
  assert.equal(engine.snapshot().actors.athena.status, 'active');
  await engine.submit({ type: 'advance', amount: 1, effects: { [engine.snapshot().activities[0].id]: { result: 'done' } } });
  assert.equal(engine.snapshot().activities[0].status, 'completed');
  assert.equal(engine.snapshot().events[0].activity.status, 'active');
  assert.equal(engine.snapshot().objects.result, 'done'); assert.equal(engine.snapshot().clock, 2);
  assert.equal(engine.snapshot().actors.athena.status, 'idle');
});

test('actor status records location and interrupt state', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'pallas', name: 'inspect seedlings', location: 'South Garden', duration: 5, writes: ['garden-log'], interruptSignals: ['request'] });
  assert.equal(engine.snapshot().actors.pallas.location, 'South Garden');
  assert.equal(engine.snapshot().actors.pallas.untilAt, 5);
  await engine.submit({ type: 'interrupt', actor: 'pallas', signal: 'request', mode: 'pause' });
  assert.equal(engine.snapshot().actors.pallas.status, 'paused');
  assert.equal(engine.snapshot().actors.pallas.activity, 'inspect seedlings');
});

test('only meaningful signals interrupt and cancellation releases resources', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'pallas', name: 'write', duration: 8, writes: ['desk'], interruptSignals: ['danger'] });
  const ignored = await engine.submit({ type: 'interrupt', signal: 'weather' });
  assert.equal(ignored.ok, false); assert.equal(engine.snapshot().activities[0].status, 'active');
  const interrupted = await engine.submit({ type: 'interrupt', signal: 'danger', mode: 'cancel' });
  assert.equal(interrupted.ok, true); assert.equal(engine.snapshot().activities[0].status, 'cancelled');
  assert.equal((await engine.submit({ type: 'schedule', actor: 'athena', name: 'use desk', duration: 1, writes: ['desk'] })).ok, true);
});

test('private events and memories are filtered by actor', async () => {
  const engine = await make();
  await engine.submit({ type: 'remember', actor: 'pallas', content: { thought: 'private' } });
  assert.equal(engine.view('athena').events.length, 0); assert.equal(engine.view('athena').memories.length, 0);
  assert.equal(engine.view('pallas').events.length, 1); assert.equal(engine.view('pallas').memories.length, 1);
});

test('snapshot restart preserves state and event sequence', async () => {
  const store = new MemoryStore(); const first = await make(store);
  await first.submit({ type: 'set', actor: 'athena', target: 'table', value: 'book' });
  await first.submit({ type: 'advance', amount: 3 });
  const restarted = await make(store);
  assert.deepEqual(restarted.snapshot(), first.snapshot());
  const result = await restarted.submit({ type: 'set', actor: 'pallas', target: 'chair', value: 'occupied' });
  assert.equal(result.events[0].sequence, 3);
});

test('pause blocks mutation until resumed', async () => {
  const engine = await make(); await engine.submit({ type: 'pause' });
  assert.equal((await engine.submit({ type: 'advance', amount: 1 })).reason, 'simulation paused');
  await engine.submit({ type: 'resume' }); assert.equal((await engine.submit({ type: 'advance', amount: 1 })).ok, true);
});

test('movement consumes time and changes location only on completion', async () => {
  const engine = await make();
  await engine.submit({ type: 'move', actor: 'athena', name: 'walk to Archive', destination: 'Archive', duration: 2 });
  assert.equal(engine.snapshot().actors.athena.location, 'Agora');
  await engine.submit({ type: 'advance', amount: 2 });
  assert.equal(engine.snapshot().actors.athena.location, 'Archive');
  assert.match(engine.snapshot().journal[0].text, /arrived at Archive/);
});

test('activity outcomes update world and paused work can resume', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'pallas', name: 'measure soil', location: 'South Garden', duration: 3,
    effects: { soil: 'measured' }, outcome: 'Pallas completed the soil survey.', interruptSignals: ['request'] });
  await engine.submit({ type: 'interrupt', actor: 'pallas', signal: 'request', mode: 'pause' });
  const activityId = engine.snapshot().activities[0].id;
  await engine.submit({ type: 'activity.resume', activityId });
  await engine.submit({ type: 'advance', amount: 3 });
  assert.equal(engine.snapshot().objects.soil, 'measured');
  assert.equal(engine.snapshot().journal[0].text, 'Pallas completed the soil survey.');
});

test('start effects reserve a resource immediately and completion effects release it', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'minerva', name: 'weave cloth', location: 'Agora', duration: 4, writes: ['loom'],
    startEffects: { loom: { status: 'occupied', user: 'minerva' }, cloth: { status: 'in progress' } }, cancelEffects: { loom: { status: 'available' } },
    effects: { loom: { status: 'available' }, cloth: { status: 'complete', maker: 'minerva' } } });
  assert.deepEqual(engine.snapshot().objects.loom, { status: 'occupied', user: 'minerva' });
  assert.equal(engine.snapshot().objects.cloth.status, 'in progress');
  await engine.submit({ type: 'advance', amount: 4 });
  assert.equal(engine.snapshot().objects.loom.status, 'available');
  assert.deepEqual(engine.snapshot().objects.cloth, { status: 'complete', maker: 'minerva' });
});

test('scenario JSON defines actors, locations, and objects for a new run', async () => {
  const engine = await make();
  const result = await engine.submit({ type: 'scenario.load', scenario: { name: 'test-scenario', actors: [{ id: 'rowan', location: 'Studio' }],
    locations: [{ name: 'Studio', description: 'A quiet room' }], objects: { lamp: 'lit' } } });
  assert.equal(result.ok, true); assert.equal(engine.snapshot().actors.rowan.location, 'Studio');
  assert.equal(engine.snapshot().locations.Studio.description, 'A quiet room'); assert.equal(engine.snapshot().objects.lamp, 'lit');
});

test('AI proposals remain pending until explicitly resolved', async () => {
  const engine = await make();
  const created = await engine.submit({ type: 'proposal.create', proposal: { actor: 'athena', provider: 'gemini', model: 'test', rationale: 'Study next.',
    command: { type: 'schedule', actor: 'athena', name: 'study', location: 'Agora', duration: 1, reads: [], writes: [] } } });
  assert.equal(created.ok, true);
  assert.equal(engine.snapshot().activities.length, 0);
  const proposal = engine.snapshot().proposals[0];
  assert.equal(proposal.status, 'pending');
  await engine.submit(proposal.command);
  await engine.submit({ type: 'proposal.resolve', proposalId: proposal.id, resolution: 'approved' });
  assert.equal(engine.snapshot().proposals[0].status, 'approved');
  assert.equal(engine.snapshot().activities.length, 1);
});

test('social activities require co-location and reserve both actors attention', async () => {
  const engine = await make();
  const elsewhere = await engine.submit({ type: 'schedule', actor: 'athena', targetActor: 'pallas', name: 'compare notes', location: 'Archive', duration: 1 });
  assert.equal(elsewhere.reason, 'interaction partner is elsewhere');
  const together = await engine.submit({ type: 'schedule', actor: 'athena', targetActor: 'minerva', name: 'discuss the loom', location: 'Agora', duration: 2 });
  assert.equal(together.ok, true);
  const busy = await engine.submit({ type: 'schedule', actor: 'minerva', name: 'begin another task', location: 'Agora', duration: 1 });
  assert.equal(busy.reason, 'resource conflict');
  assert.equal(engine.snapshot().activities[0].targetActor, 'minerva');
});

test('completed social activities preserve exact dialogue in the journal', async () => {
  const engine = await make();
  await engine.submit({ type: 'schedule', actor: 'athena', targetActor: 'minerva', name: 'compare plans', location: 'Agora', duration: 1,
    spokenText: 'The two plans share one unsupported assumption.', outcome: 'Athena and Minerva compared their plans.' });
  await engine.submit({ type: 'advance', amount: 1 });
  const dialogue = engine.snapshot().journal.find((entry) => entry.kind === 'dialogue');
  assert.equal(dialogue.actor, 'athena');
  assert.equal(dialogue.targetActor, 'minerva');
  assert.equal(dialogue.spokenText, 'The two plans share one unsupported assumption.');
});
