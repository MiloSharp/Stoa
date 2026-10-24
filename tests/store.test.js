import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/store.js';

test('PostgreSQL commit is transactional and persists events before snapshot', async () => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push([sql.trim(), args]); return { rows: [] }; }, release() { calls.push(['RELEASE']); } };
  const pool = { connect: async () => client, end: async () => {}, query: async () => ({ rows: [] }) };
  const store = new PostgresStore(pool);
  await store.commit('sim', [{ id: '00000000-0000-4000-8000-000000000001', sequence: 1, simulatedAt: 0, type: 'world.set', actor: 'athena', visibility: 'shared', target: 'table', value: 'book' }], { version: 1, sequence: 1 });
  assert.equal(calls[0][0], 'BEGIN');
  assert.match(calls[1][0], /pg_advisory_xact_lock/);
  assert.match(calls[2][0], /INSERT INTO stoa_events/);
  assert.match(calls[3][0], /INSERT INTO stoa_snapshots/);
  assert.equal(calls[4][0], 'COMMIT'); assert.equal(calls[5][0], 'RELEASE');
});
