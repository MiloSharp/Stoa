import test from 'node:test';
import assert from 'node:assert/strict';
import { StoaEngine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { createProvider } from '../src/providers/index.js';
import { AutonomyController } from '../src/autonomy.js';

const setup = async () => {
  const engine = await new StoaEngine({ store: new MemoryStore(), simulationId: 'autonomy-test' }).initialize();
  return { engine, controller: new AutonomyController({ engine, provider: createProvider('mock') }) };
};

test('one autonomous cycle schedules independent goals together and advances to the next completion', async () => {
  const { engine, controller } = await setup();
  const result = await controller.cycle();
  assert.equal(result.ok, true);
  assert.equal(result.decisions.length, 3);
  assert.equal(result.decisions.every((decision) => decision.accepted), true);
  assert.equal(engine.snapshot().clock, 1);
  assert.equal(engine.snapshot().actors.minerva.activity, 'weave cloth on the loom');
  assert.equal(engine.snapshot().actors.athena.location, 'Archive');
  assert.equal(engine.snapshot().actors.pallas.location, 'South Garden');
});

test('bounded autonomous run completes opening goals, enters routines, and records its reasons', async () => {
  const { engine, controller } = await setup();
  const result = await controller.run({ maxCycles: 10 });
  assert.equal(result.ok, true);
  assert.equal(engine.snapshot().objects.cloth.status, 'complete');
  assert.equal(engine.snapshot().objects['archive-study'], 'complete');
  assert.equal(engine.snapshot().objects['garden-inspection'], 'complete');
  assert.match(engine.snapshot().actors.minerva.lastDecision.rationale, /weav/i);
  assert.ok(result.cycles <= 10);
  assert.ok(engine.snapshot().activities.some((activity) => activity.goalId === 'practice-craft'));
});

test('autonomy obeys pause and the hard cycle limit', async () => {
  const { engine, controller } = await setup();
  await engine.submit({ type: 'pause' });
  assert.equal((await controller.cycle()).reason, 'simulation paused');
  await engine.submit({ type: 'resume' });
  const result = await controller.run({ maxCycles: 1 });
  assert.equal(result.cycles, 1);
});
