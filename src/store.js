export class MemoryStore {
  constructor() { this.events = []; this.snapshots = []; }
  async initialize() {}
  async load(simulationId) {
    const snapshots = this.snapshots.filter((x) => x.simulationId === simulationId);
    const latest = snapshots.at(-1) ?? null;
    const after = latest?.lastSequence ?? 0;
    return { snapshot: latest?.state ? structuredClone(latest.state) : null,
      events: structuredClone(this.events.filter((x) => x.simulationId === simulationId && x.sequence > after)) };
  }
  async commit(simulationId, events, state) {
    this.events.push(...structuredClone(events.map((event) => ({ ...event, simulationId }))));
    this.snapshots.push({ simulationId, version: state.version, lastSequence: state.sequence, state: structuredClone(state) });
  }
  async listRuns() { return [...new Set(this.snapshots.map((item) => item.simulationId))].sort(); }
  async reset(simulationId) { this.events = this.events.filter((item) => item.simulationId !== simulationId); this.snapshots = this.snapshots.filter((item) => item.simulationId !== simulationId); }
  async close() {}
}

export class PostgresStore {
  constructor(pool) { this.pool = pool; }
  static async connect(connectionString) {
    const { Pool } = await import('pg');
    return new PostgresStore(new Pool({ connectionString }));
  }
  async initialize() { await this.pool.query('SELECT 1'); }
  async load(simulationId) {
    const snap = await this.pool.query(
      'SELECT state, last_sequence FROM stoa_snapshots WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1', [simulationId]);
    const snapshot = snap.rows[0]?.state ?? null;
    const after = Number(snap.rows[0]?.last_sequence ?? 0);
    const rows = await this.pool.query(
      'SELECT sequence,event_id AS id,simulated_at,event_type AS type,actor,visibility,payload FROM stoa_events WHERE simulation_id=$1 AND sequence>$2 ORDER BY sequence',
      [simulationId, after]);
    return { snapshot, events: rows.rows.map((r) => ({ ...r, sequence: Number(r.sequence), simulatedAt: Number(r.simulated_at), ...r.payload })) };
  }
  async commit(simulationId, events, state) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [simulationId]);
      for (const event of events) {
        const { id, sequence, simulatedAt, type, actor = null, visibility = 'shared', ...payload } = event;
        await client.query(
          `INSERT INTO stoa_events(simulation_id,sequence,event_id,simulated_at,event_type,actor,visibility,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [simulationId, sequence, id, simulatedAt, type, actor, visibility, payload]);
      }
      await client.query(
        `INSERT INTO stoa_snapshots(simulation_id,version,last_sequence,state) VALUES($1,$2,$3,$4)
         ON CONFLICT(simulation_id,version) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,state=EXCLUDED.state`,
        [simulationId, state.version, state.sequence, state]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async listRuns() {
    const result = await this.pool.query('SELECT simulation_id, max(created_at) AS updated_at FROM stoa_snapshots GROUP BY simulation_id ORDER BY simulation_id');
    return result.rows.map((row) => ({ id: row.simulation_id, updatedAt: row.updated_at }));
  }
  async reset(simulationId) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query('DELETE FROM stoa_events WHERE simulation_id=$1', [simulationId]); await client.query('DELETE FROM stoa_snapshots WHERE simulation_id=$1', [simulationId]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
