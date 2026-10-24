import test from 'node:test';
import assert from 'node:assert/strict';
import { activitiesConflict } from '../src/conflicts.js';

test('read/read is independent while write/read and write/write conflict', () => {
  assert.equal(activitiesConflict({ reads: ['x'], writes: [] }, { reads: ['x'], writes: [] }), false);
  assert.equal(activitiesConflict({ reads: ['x'], writes: [] }, { reads: [], writes: ['x'] }), true);
  assert.equal(activitiesConflict({ reads: [], writes: ['x'] }, { reads: [], writes: ['x'] }), true);
});
