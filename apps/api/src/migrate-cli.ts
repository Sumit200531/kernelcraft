import pg from 'pg';
import { loadEnv } from './env.js';
import { migrate } from './migrate.js';

const env = loadEnv();
if (!env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const applied = await migrate(pool);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await pool.end();
