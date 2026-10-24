import {poolFromEnv,createPersistedRun,transactRun,propose,commit,resume,pause} from './pg-store.js';
import {initialScenario,journal} from './engine.js';
if(!process.env.STOA_DATABASE_URL) throw Error('STOA_DATABASE_URL is required');
const pool=poolFromEnv();try{
 const id=await createPersistedRun(pool,initialScenario());
 await transactRun(pool,id,r=>resume(r));
 const result=await transactRun(pool,id,r=>{const p=propose(r,'pallas',{type:'set',target:'notebook',value:'a map'});return commit(r,p.id)});
 await transactRun(pool,id,r=>pause(r));
 console.log('RUN ID:',id,'\nCOMMIT:',result.result,'\nJOURNAL:',journal(result.run));
}finally{await pool.end();}
