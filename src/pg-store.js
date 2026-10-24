// Transactional persistence. The entire initial prototype state is checkpointed atomically;
// stoa_events and observations form a separately queryable audit trail.
import {Pool} from 'pg';
import {createRun,propose,commit,resume,pause} from './engine.js';
export const poolFromEnv=()=>new Pool({connectionString:process.env.STOA_DATABASE_URL,
  ...(process.env.STOA_DATABASE_URL?.includes('localhost')?{ssl:false}:{})});
export async function createPersistedRun(pool,scenario){
 const run=createRun(scenario);const c=await pool.connect();
 try{await c.query('BEGIN');await c.query('INSERT INTO stoa_runs(id,scenario,world,version,clock,status) VALUES($1,$2,$3,$4,$5,$6)',
 [run.id,run.scenario,JSON.stringify(run.world),0,0,run.status]);
 await c.query('INSERT INTO stoa_snapshots(run_id,state) VALUES($1,$2)',[run.id,JSON.stringify(run)]);
 for(const [id,state] of Object.entries(run.agents)) await c.query('INSERT INTO stoa_agents(run_id,id,profile,state) VALUES($1,$2,$3,$4)',[run.id,id,JSON.stringify({id}),JSON.stringify(state)]);
 await c.query('COMMIT');return run.id;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function transactRun(pool,id,mutator){
 const c=await pool.connect();try{
 await c.query('BEGIN');const q=await c.query('SELECT state FROM stoa_snapshots WHERE run_id=$1 FOR UPDATE',[id]);
 if(!q.rows.length) throw Error('run not found');
 const run=q.rows[0].state;const previousVersion=run.version;
 const result=await mutator(run);
 await c.query('UPDATE stoa_snapshots SET state=$2 WHERE run_id=$1',[id,JSON.stringify(run)]);
 await c.query('UPDATE stoa_runs SET world=$2,version=$3,clock=$4,status=$5 WHERE id=$1',
 [id,JSON.stringify(run.world),run.version,run.clock,run.status]);
 for(const e of run.events.filter(e=>e.sequence>previousVersion)){
 await c.query(`INSERT INTO stoa_events(run_id,sequence,event_id,action,actor,simulated_at,visibility)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
 [id,e.sequence,e.id,JSON.stringify(e.action),e.actor,e.simulatedAt,e.visibility]);
 for(const o of run.observations.filter(o=>o.sequence===e.sequence))
 await c.query(`INSERT INTO stoa_observations(run_id,sequence,observer,perception)
 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,e.sequence,o.observer,JSON.stringify(o.perception)]);
 }
 await c.query('COMMIT');return {result,run};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export {propose,commit,resume,pause};
