import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { Client } = await import('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const sql = await readFile(fileURLToPath(new URL('../sql/001_init.sql', import.meta.url)), 'utf8');
  await client.query(sql);
  console.log('Stoa database schema is ready.');
} finally { await client.end(); }
