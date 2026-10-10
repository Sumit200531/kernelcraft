import { loadEnv } from './env.js';
import { buildApp } from './app.js';
import { MemoryStore, PgStore, type Store } from './store.js';
import { migrate } from './migrate.js';
import { openAiChat } from './llm.js';

const env = loadEnv();

let store: Store;
if (env.DATABASE_URL) {
  const pg = PgStore.fromUrl(env.DATABASE_URL);
  const applied = await migrate(pg.pool);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
  store = pg;
} else {
  console.warn('DATABASE_URL is not set: recordings are kept in memory and lost on restart.');
  store = new MemoryStore();
}

const app = await buildApp({
  store,
  chat: openAiChat(env),
  corsOrigin: env.CORS_ORIGIN.split(',').map(s => s.trim()),
  staticDir: env.STATIC_DIR,
  logLevel: env.LOG_LEVEL
});

const shutdown = async () => { await app.close(); await store.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
console.log(`KernelCraft API on http://${env.HOST}:${env.PORT} (storage: ${store.kind})`);
