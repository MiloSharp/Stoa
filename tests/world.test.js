import test from 'node:test';
import assert from 'node:assert/strict';
import { directExit, nextStepToward, normalizeTopology, routeBetween, topologyError } from '../src/world.js';

const topology = normalizeTopology({
  Agora: { name: 'Agora', exits: { Archive: { duration: 1 }, Garden: { duration: 2 } } },
  Archive: { name: 'Archive', exits: { Agora: { duration: 1 } } },
  Garden: { name: 'Garden', exits: { Agora: { duration: 2 } } }
});

test('world topology finds directed routes and their next step', () => {
  assert.deepEqual(routeBetween(topology, 'Archive', 'Garden'), ['Archive', 'Agora', 'Garden']);
  assert.equal(nextStepToward(topology, 'Archive', 'Garden'), 'Agora');
  assert.equal(directExit(topology, 'Agora', 'Garden').duration, 2);
});

test('legacy locations retain complete-graph movement', () => {
  const legacy = normalizeTopology({ One: { name: 'One' }, Two: { name: 'Two' } }, { legacyComplete: true });
  assert.equal(directExit(legacy, 'One', 'Two').duration, 1);
});

test('topology validation rejects impossible exits', () => {
  const invalid = normalizeTopology({ One: { name: 'One', exits: { Missing: { duration: 0 } } } });
  assert.match(topologyError(invalid), /unknown destination/);
});
