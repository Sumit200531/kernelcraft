import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getSample } from '@kernelcraft/engine';
import { buildApp } from '../src/app.js';
import { PgStore } from '../src/store.js';
import { migrate } from '../src/migrate.js';
import { startPostgres } from './pg-helper.js';

let server: Awaited<ReturnType<typeof startPostgres>>;
let store: PgStore;
let app: FastifyInstance;

beforeAll(async () => {
  server = await startPostgres();
  store = PgStore.fromUrl(server.url);
  await migrate(store.pool);
  app = await buildApp({ store });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await store?.close();
  await server?.stop();
});

describe('PostgreSQL storage', () => {
  it('migrations are recorded and idempotent', async () => {
    expect(await migrate(store.pool)).toEqual([]);
    const { rows } = await store.pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map(r => r.name)).toEqual(['001_recordings.sql', '002_assistant_log.sql']);
  });

  it('concurrent migrators do not conflict (advisory lock)', async () => {
    const results = await Promise.all([migrate(store.pool), migrate(store.pool), migrate(store.pool)]);
    expect(results.flat()).toEqual([]);
  });

  it('health reports the database as up', async () => {
    expect((await app.inject('/api/health')).json()).toMatchObject({ storage: 'postgres', database: 'up' });
  });

  it('stores a recording, survives a new connection pool, and verifies it', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/recordings', payload: {
      title: 'Lost updates', notes: 'quantum=2', source: getSample('race-counter')!.source, inputs: []
    } });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.summary.findings[0].kind).toBe('race');

    // read back through a completely separate pool: it really is in the database
    const other = new pg.Pool({ connectionString: server.url });
    const { rows } = await other.query('SELECT title, trace_hash, inputs, summary FROM recordings WHERE id = $1', [rec.id]);
    await other.end();
    expect(rows[0]).toMatchObject({ title: 'Lost updates', trace_hash: rec.traceHash, inputs: [] });

    const v = (await app.inject({ method: 'POST', url: `/api/recordings/${rec.id}/verify` })).json();
    expect(v.reproducible).toBe(true);
  });

  it('detects a recording whose stored hash no longer matches (tampering / engine drift)', async () => {
    const rec = (await app.inject({ method: 'POST', url: '/api/recordings', payload: { title: 'convoy', source: getSample('convoy')!.source } })).json();
    await store.pool.query(`UPDATE recordings SET trace_hash = 'deadbeef' WHERE id = $1`, [rec.id]);
    const v = (await app.inject({ method: 'POST', url: `/api/recordings/${rec.id}/verify` })).json();
    expect(v).toMatchObject({ reproducible: false, stored: 'deadbeef', actual: rec.traceHash });
  });

  it('lists with pagination, updates, deletes and 404s on unknown or malformed ids', async () => {
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/api/recordings', payload: { title: `run ${i}`, source: getSample('convoy')!.source } });
    const page1 = (await app.inject('/api/recordings?limit=2&offset=0')).json();
    const page2 = (await app.inject('/api/recordings?limit=2&offset=2')).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThanOrEqual(5);
    expect(new Set([...page1.items, ...page2.items].map((x: { id: string }) => x.id)).size).toBe(page1.items.length + page2.items.length);

    const id = page1.items[0].id;
    const up = (await app.inject({ method: 'PATCH', url: `/api/recordings/${id}`, payload: { title: 'renamed' } })).json();
    expect(up.title).toBe('renamed');
    expect(new Date(up.updatedAt) >= new Date(up.createdAt)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/recordings/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/recordings/${id}` })).statusCode).toBe(404);
    expect((await app.inject('/api/recordings/not-a-uuid')).statusCode).toBe(404);
    expect((await app.inject("/api/recordings/'; DROP TABLE recordings; --")).statusCode).toBe(404);
    expect((await store.pool.query('SELECT count(*) FROM recordings')).rows[0].count).not.toBe('0');
  });

  it('the database enforces constraints even if the API is bypassed', async () => {
    await expect(store.pool.query(`INSERT INTO recordings (title, source, trace_hash, status, ticks, summary, engine_version) VALUES ('', 'x', 'aaaaaaaa', 'done', 1, '{}', '1')`)).rejects.toThrow(/check constraint/);
    await expect(store.pool.query(`INSERT INTO recordings (title, source, trace_hash, status, ticks, summary, engine_version) VALUES ('t', 'x', 'aaaaaaaa', 'exploded', 1, '{}', '1')`)).rejects.toThrow(/check constraint/);
  });

  it('logs assistant questions linked to a recording, and cascades on delete', async () => {
    const rec = (await app.inject({ method: 'POST', url: '/api/recordings', payload: { title: 'abba', source: getSample('deadlock-abba')!.source } })).json();
    const ask = (await app.inject({ method: 'POST', url: '/api/assistant/ask', payload: { source: getSample('deadlock-abba')!.source, question: 'why stuck?', recordingId: rec.id } })).json();
    const { rows } = await store.pool.query('SELECT intent, citations, trace_hash FROM assistant_log WHERE recording_id = $1', [rec.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('deadlock');
    expect(rows[0].citations).toEqual(ask.citations);
    await app.inject({ method: 'DELETE', url: `/api/recordings/${rec.id}` });
    expect((await store.pool.query('SELECT count(*)::int AS n FROM assistant_log WHERE recording_id = $1', [rec.id])).rows[0].n).toBe(0);
  });
});
