import {
  Session, parseWorkload, analyze, answerQuestion, explainEvent, runToEnd, traceHash, applyConfigPatch, getSample, SAMPLES,
  type Analysis, type Config, type Diagnostic, type Experiment, type InjectAction, type Injection, type Machine, type SimEvent,
  type TickRecord, type Workload, type Explanation
} from '@kernelcraft/engine';
import { api, type ApiHealth, type RecordingItem } from './api';

export type CenterTab = 'timeline' | 'memory' | 'sync' | 'metrics' | 'lab';
export type SideTab = 'findings' | 'assistant' | 'inspector';
export interface TermLine { kind: 'in' | 'out' | 'err' | 'info' | 'ok'; text: string }
export interface ChatMsg { role: 'user' | 'assistant'; text: string; intent?: string; model?: string; note?: string; pending?: boolean }

const LS_SOURCE = 'kc.source.v1';
const LS_RECORDINGS = 'kc.recordings.v1';
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
};

export interface LocalRecording { id: string; title: string; source: string; inputs: Injection[]; traceHash: string; status: string; ticks: number; createdAt: string }

/**
 * Owns the simulation session and all UI state. React components subscribe to
 * `version` and read fields directly; every mutation goes through a method that
 * bumps the version.
 */
export class Controller {
  source: string;
  sampleId: string | null = null;
  diagnostics: Diagnostic[] = [];
  dirty = false;

  workload: Workload | null = null;
  session: Session | null = null;
  /** the same run executed to the end: full event log, timeline and analysis */
  full: Machine | null = null;
  fullEvents: SimEvent[] = [];
  fullTicks: TickRecord[] = [];
  analysis: Analysis | null = null;
  hash = '';

  playing = false;
  speed = 12;                 // ticks per second
  selectedEvent: number | null = null;
  selectedTid: number | null = null;
  explanation: Explanation | null = null;
  tab: CenterTab = 'timeline';
  side: SideTab = 'findings';
  showHelp = false;
  showRecordings = false;
  flash: string | null = null;

  term: TermLine[] = [{ kind: 'info', text: 'KernelCraft terminal. Type `help` for commands.' }];
  chat: ChatMsg[] = [];
  narrate = false;

  health: ApiHealth | null = null;
  recordings: (RecordingItem | LocalRecording)[] = [];
  recordingsSource: 'api' | 'local' = 'local';

  version = 0;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const saved = ls.get(LS_SOURCE);
    const fromHash = typeof location !== 'undefined' ? /sample=([\w-]+)/.exec(location.hash)?.[1] : undefined;
    const sample = getSample(fromHash ?? '') ?? (saved ? null : SAMPLES[0]);
    this.source = sample ? sample.source : saved!;
    this.sampleId = sample ? sample.id : null;
    this.reparse();
  }

  /* --------------------------------------------------------- reactivity */
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  emit() { this.version++; for (const l of this.listeners) l(); }

  get machine(): Machine | null { return this.session?.machine ?? null; }
  get cursor(): number { return this.session?.machine.s.tick ?? 0; }
  get horizon(): number { return this.session?.horizon ?? 0; }
  get inputs(): Injection[] { return this.session?.inputs ?? []; }

  toast(msg: string) {
    this.flash = msg;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flash = null; this.emit(); }, 2600);
    this.emit();
  }

  /* --------------------------------------------------------- source */
  setSource(src: string) {
    this.source = src;
    this.dirty = true;
    this.sampleId = null;
    ls.set(LS_SOURCE, src);
    this.reparse();
    this.emit();
  }

  private reparse() { this.diagnostics = parseWorkload(this.source).diagnostics; }

  loadSample(id: string) {
    const s = getSample(id);
    if (!s) return false;
    this.source = s.source;
    this.sampleId = id;
    ls.set(LS_SOURCE, s.source);
    this.reparse();
    this.run({ inputs: [], cursor: 0 });
    this.chat = [];
    try { history.replaceState(null, '', `#sample=${id}`); } catch { /* sandboxed */ }
    return true;
  }

  /* --------------------------------------------------------- execution */

  /** Parse and execute the current source. Returns false when the workload has errors. */
  run(opts: { inputs?: Injection[]; cursor?: number | 'end' } = {}): boolean {
    this.stop();
    const { workload, diagnostics } = parseWorkload(this.source);
    this.diagnostics = diagnostics;
    if (!workload) {
      const first = diagnostics.find(d => d.severity === 'error')!;
      this.print('err', `workload has ${diagnostics.filter(d => d.severity === 'error').length} error(s); first: line ${first.line}: ${first.message}`);
      this.emit();
      return false;
    }
    this.workload = workload;
    const session = new Session(workload);
    session.inputs = (opts.inputs ?? []).map(i => ({ ...i, action: { ...i.action } }));
    session.run();
    this.session = session;
    this.capture();
    this.dirty = false;
    this.selectedEvent = null; this.explanation = null;
    const c = opts.cursor ?? 'end';
    session.seek(c === 'end' ? session.horizon : Math.min(c, session.horizon));
    this.emit();
    return true;
  }

  /** Snapshot the complete run (the session is at its horizon). */
  private capture() {
    const s = this.session!;
    this.full = runToEnd(s.workload, s.inputs);
    this.fullEvents = this.full.visibleEvents();
    this.fullTicks = this.full.visibleTicks();
    this.hash = traceHash(this.full);
    this.analysis = analyze(this.full, { inputs: s.inputs });
  }

  /** Any explicit navigation stops playback. */
  seek(t: number) {
    if (!this.session) return;
    this.touched = true;
    this.stop();
    this.session.seek(Math.max(0, Math.min(t, this.session.horizon)));
    this.emit();
  }
  step(n = 1) { this.seek(this.cursor + n); }

  /** Start playback once on load, unless the user has already taken control. */
  autoplay() { if (!this.touched) this.play(); }
  private touched = false;

  play() {
    if (!this.session) return;
    if (this.cursor >= this.horizon) this.session.seek(0);
    this.playing = true;
    this.lastFrame = performance.now();
    this.acc = 0;
    const frame = (now: number) => {
      if (!this.playing) return;
      this.acc += ((now - this.lastFrame) / 1000) * this.speed;
      this.lastFrame = now;
      const n = Math.floor(this.acc);
      if (n > 0) {
        this.acc -= n;
        this.session!.seek(Math.min(this.cursor + n, this.horizon));
        if (this.cursor >= this.horizon) { this.playing = false; this.emit(); return; }
        this.emit();
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    this.emit();
  }
  private stop() { if (this.playing) { this.playing = false; cancelAnimationFrame(this.raf); this.emit(); } }
  pause() { this.touched = true; this.stop(); }
  toggle() { this.touched = true; if (this.playing) this.stop(); else this.play(); }
  setSpeed(v: number) { this.speed = Math.max(1, Math.min(240, v)); this.emit(); }

  /** Operator action at the current tick. Discards the recorded future (a new branch) and re-runs. */
  inject(action: InjectAction): string | null {
    const s = this.session, m = this.machine;
    if (!s || !m) return 'nothing is loaded';
    if (action.type === 'kill' && (!m.s.threads[action.tid] || m.s.threads[action.tid].state === 'terminated')) return `thread ${action.tid} is not alive`;
    if (action.type === 'signal' && !m.s.sems[action.s]) return `no semaphore ${action.s}`;
    if (action.type === 'unlock' && (!m.s.mutexes[action.m] || m.s.mutexes[action.m].owner < 0)) return `mutex ${action.m} is not held`;
    this.pause();
    const at = this.cursor;
    s.inject(action);
    s.run();
    this.capture();
    s.seek(Math.min(at + 1, s.horizon));
    this.emit();
    return null;
  }

  applyPatch(patch: Partial<Config>) {
    this.source = applyConfigPatch(this.source, patch);
    ls.set(LS_SOURCE, this.source);
    this.sampleId = null;
    return this.run({ cursor: 'end' });
  }

  /** Make an analyzer experiment real: edit the workload or apply the injection. */
  applyExperiment(exp: Experiment) {
    const c = exp.change;
    if (c.kind === 'config') { this.applyPatch(c.patch); this.toast(`Applied ${exp.label}`); }
    else if (c.kind === 'inject') { this.seek(c.at); const err = this.inject(c.action); this.toast(err ?? `Applied ${exp.label}`); }
    else {
      const re = new RegExp(`^(\\s*)(inc|dec)(\\s+)${c.var}\\b`, 'gm');
      this.source = this.source.replace(re, (_m, ind, op, sp) => `${ind}atomic_${op}${sp}${c.var}`);
      ls.set(LS_SOURCE, this.source);
      this.run({ cursor: 'end' });
      this.toast(`Rewrote updates to ${c.var} as atomic instructions`);
    }
  }

  /* --------------------------------------------------------- inspection */
  selectEvent(id: number | null, seek = true) {
    this.selectedEvent = id;
    this.explanation = id !== null && this.full ? explainEvent(this.full, id) : null;
    if (id !== null) {
      const e = this.fullEvents[id];
      if (e?.tid !== undefined) this.selectedTid = e.tid;
      if (seek && e) this.seek(Math.min(e.t + 1, this.horizon));
      this.side = 'inspector';
    }
    this.emit();
  }
  selectThread(tid: number | null) { this.selectedTid = tid; this.emit(); }
  setTab(t: CenterTab) { this.tab = t; this.emit(); }
  setSide(t: SideTab) { this.side = t; this.emit(); }
  setHelp(v: boolean) { this.showHelp = v; this.emit(); }
  chatFocusTick = 0;
  focusChat() { this.side = 'assistant'; this.chatFocusTick++; this.emit(); }

  /* --------------------------------------------------------- terminal */
  print(kind: TermLine['kind'], text: string) {
    this.term.push(...text.split('\n').map(t => ({ kind, text: t })));
    if (this.term.length > 600) this.term.splice(0, this.term.length - 600);
  }
  clearTerm() { this.term = []; this.emit(); }

  /* --------------------------------------------------------- assistant */
  async ask(question: string) {
    if (!this.full) return;
    this.chat.push({ role: 'user', text: question });
    const local = answerQuestion(this.full, question, this.analysis ?? undefined);
    const msg: ChatMsg = { role: 'assistant', text: local.text, intent: local.intent };
    this.chat.push(msg);
    this.side = 'assistant';
    if (this.narrate && this.health?.narration === 'llm') {
      msg.pending = true; this.emit();
      try {
        const r = await api.ask({ source: this.source, inputs: this.inputs, question, narrate: true });
        if (r.narration) { msg.text = r.narration.text; msg.model = r.narration.model; }
        else if (r.narrationError) msg.note = r.narrationError;
      } catch (e) { msg.note = `narration unavailable: ${(e as Error).message}`; }
      msg.pending = false;
    }
    this.emit();
  }
  setNarrate(v: boolean) { this.narrate = v; this.emit(); }

  /* --------------------------------------------------------- backend */
  async checkHealth() {
    try { this.health = await api.health(); } catch { this.health = null; }
    this.emit();
  }

  async refreshRecordings() {
    if (this.health) {
      try { this.recordings = (await api.listRecordings()).items; this.recordingsSource = 'api'; this.emit(); return; } catch { /* fall through */ }
    }
    this.recordings = this.localRecordings();
    this.recordingsSource = 'local';
    this.emit();
  }
  private localRecordings(): LocalRecording[] { try { return JSON.parse(ls.get(LS_RECORDINGS) ?? '[]'); } catch { return []; } }

  async saveRecording(title: string): Promise<string> {
    if (!this.full || this.dirty) { if (!this.run({ inputs: this.inputs })) return 'fix the workload first'; }
    if (this.health) {
      try { const r = await api.createRecording({ title, source: this.source, inputs: this.inputs }); await this.refreshRecordings(); return `saved "${r.title}" to ${this.health.storage} (${r.traceHash})`; }
      catch (e) { return `save failed: ${(e as Error).message}`; }
    }
    const list = this.localRecordings();
    list.unshift({ id: `local-${Date.now().toString(36)}`, title, source: this.source, inputs: this.inputs, traceHash: this.hash, status: this.full!.s.status, ticks: this.full!.s.tick, createdAt: new Date().toISOString() });
    ls.set(LS_RECORDINGS, JSON.stringify(list.slice(0, 50)));
    await this.refreshRecordings();
    return `saved "${title}" in this browser (${this.hash})`;
  }

  async openRecording(id: string) {
    let rec: { title: string; source: string; inputs: Injection[]; traceHash: string } | undefined;
    if (id.startsWith('local-')) rec = this.localRecordings().find(r => r.id === id);
    else rec = await api.getRecording(id);
    if (!rec) return 'recording not found';
    this.source = rec.source; this.sampleId = null; ls.set(LS_SOURCE, rec.source);
    this.run({ inputs: rec.inputs, cursor: 'end' });
    this.showRecordings = false;
    const same = this.hash === rec.traceHash;
    this.toast(same ? `Replayed "${rec.title}" — trace ${this.hash} matches` : `Replayed "${rec.title}" — trace differs (${rec.traceHash} → ${this.hash})`);
    return null;
  }

  async verifyRecording(id: string): Promise<string> {
    if (id.startsWith('local-')) {
      const rec = this.localRecordings().find(r => r.id === id);
      if (!rec) return 'not found';
      const w = parseWorkload(rec.source).workload;
      if (!w) return 'workload no longer parses';
      const h = traceHash(runToEnd(w, rec.inputs));
      return h === rec.traceHash ? `reproducible ✓ (${h})` : `NOT reproducible: stored ${rec.traceHash}, now ${h}`;
    }
    const v = await api.verifyRecording(id);
    return v.reproducible ? `reproducible ✓ (${v.actual})` : `NOT reproducible: stored ${v.stored}, now ${v.actual}`;
  }

  async deleteRecording(id: string) {
    if (id.startsWith('local-')) ls.set(LS_RECORDINGS, JSON.stringify(this.localRecordings().filter(r => r.id !== id)));
    else await api.deleteRecording(id);
    await this.refreshRecordings();
  }

  /** Open the recordings dialog; `save` focuses the title field for saving the current run. */
  saveIntent = false;
  setRecordings(v: boolean, save = false) { this.showRecordings = v; this.saveIntent = v && save; if (v) void this.refreshRecordings(); this.emit(); }
}

export const ctl = new Controller();
