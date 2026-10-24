import fs from 'node:fs/promises';import {poolFromEnv} from './pg-store.js';
if(!process.env.STOA_DATABASE_URL) throw Error('Set STOA_DATABASE_URL in the terminal; do not paste credentials into chat');
const p=poolFromEnv();try{await p.query(await fs.readFile(new URL('../sql/001_init.sql',import.meta.url),'utf8'));console.log('Stoa database schema created');}finally{await p.end();}
