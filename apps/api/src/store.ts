import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Injection } from '@kernelcraft/engine';

export interface RecordingInput {
  title: string; notes: string; source: string; inputs: Injection[];
  traceHash: string; status: string; ticks: number; summary: Record<string, unknown>; engineVersion: string;
}
export interface Recording extends RecordingInput { id: string; createdAt: string; updatedAt: string }
export interface RecordingListItem { id: string; title: string; status: string; ticks: number; traceHash: string; createdAt: string; updatedAt: string }
export interface AssistantLogInput { recordingId?: string | null; traceHash: string; question: string; intent: string; citations: number[]; narrated: boolean }

export interface Store {
  readonly kind: 'postgres' | 'memory';
  ping(): Promise<boolean>;
  create(r: RecordingInput): Promise<Recording>;
  list(limit: number, offset: number): Promise<{ items: RecordingListItem[]; total: number }>;
  get(id: string): Promise<Recording | null>;
  update(id: string, patch: Partial<Pick<Recording, 'title' | 'notes'>>): Promise<Recording | null>;
  remove(id: string): Promise<boolean>;
  logQuestion(q: AssistantLogInput): Promise<void>;
  close(): Promise<void>;
}

const listItem = (r: Recording): RecordingListItem => ({ id: r.id, title: r.title, status: r.status, ticks: r.ticks, traceHash: r.traceHash, createdAt: r.createdAt, updatedAt: r.updatedAt });

/** In-process store used when DATABASE_URL is not configured (demo / offline). */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private rows = new Map<string, Recording>();
  readonly log: AssistantLogInput[] = [];
  async ping() { return true; }
  async create(r: RecordingInput) {
    const now = new Date().toISOString();
    const rec: Recording = { ...structuredClone(r), id: randomUUID(), createdAt: now, updatedAt: now };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }
  async list(limit: number, offset: number) {
    const all = [...this.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: all.slice(offset, offset + limit).map(listItem), total: all.length };
  }
  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : null; }
  async update(id: string, patch: Partial<Pick<Recording, 'title' | 'notes'>>) {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    return structuredClone(r);
  }
  async remove(id: string) { return this.rows.delete(id); }
  async logQuestion(q: AssistantLogInput) { this.log.push(q); }
  async close() {}
}

type Row = {
  id: string; title: string; notes: string; source: string; inputs: Injection[]; trace_hash: string; status: string; ticks: number;
  summary: Record<string, unknown>; engine_version: string; created_at: Date; updated_at: Date;
};
const fromRow = (r: Row): Recording => ({
  id: r.id, title: r.title, notes: r.notes, source: r.source, inputs: r.inputs, traceHash: r.trace_hash, status: r.status, ticks: r.ticks,
  summary: r.summary, engineVersion: r.engine_version, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString()
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL store. All queries are parameterised. */
export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  constructor(readonly pool: pg.Pool) {}
  static fromUrl(url: string) { return new PgStore(new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000 })); }
  async ping() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async create(r: RecordingInput) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO recordings (title, notes, source, inputs, trace_hash, status, ticks, summary, engine_version)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9) RETURNING *`,
      [r.title, r.notes, r.source, JSON.stringify(r.inputs), r.traceHash, r.status, r.ticks, JSON.stringify(r.summary), r.engineVersion]);
    return fromRow(rows[0]);
  }
  async list(limit: number, offset: number) {
    const [{ rows }, count] = await Promise.all([
      this.pool.query<Row>('SELECT id, title, status, ticks, trace_hash, created_at, updated_at FROM recordings ORDER BY created_at DESC, id LIMIT $1 OFFSET $2', [limit, offset]),
      this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM recordings')
    ]);
    return {
      items: rows.map(r => ({ id: r.id, title: r.title, status: r.status, ticks: r.ticks, traceHash: r.trace_hash, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() })),
      total: Number(count.rows[0].n)
    };
  }
  async get(id: string) {
    if (!UUID.test(id)) return null;
    const { rows } = await this.pool.query<Row>('SELECT * FROM recordings WHERE id = $1', [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async update(id: string, patch: Partial<Pick<Recording, 'title' | 'notes'>>) {
    if (!UUID.test(id)) return null;
    const { rows } = await this.pool.query<Row>(
      `UPDATE recordings SET title = COALESCE($2, title), notes = COALESCE($3, notes), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, patch.title ?? null, patch.notes ?? null]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async remove(id: string) {
    if (!UUID.test(id)) return false;
    const r = await this.pool.query('DELETE FROM recordings WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async logQuestion(q: AssistantLogInput) {
    await this.pool.query('INSERT INTO assistant_log (recording_id, trace_hash, question, intent, citations, narrated) VALUES ($1, $2, $3, $4, $5, $6)',
      [q.recordingId && UUID.test(q.recordingId) ? q.recordingId : null, q.traceHash, q.question, q.intent, q.citations, q.narrated]);
  }
  async close() { await this.pool.end(); }
}
