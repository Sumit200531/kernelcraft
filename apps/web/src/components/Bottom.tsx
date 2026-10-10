import { useEffect, useMemo, useRef, useState } from 'react';
import { useCtl } from '../lib/use';
import { CATEGORY, CATEGORY_COLOR, threadColor, type EventCategory } from '../lib/colors';
import { execCommand } from '../lib/terminal';

const ROW = 22;
const CATS: (EventCategory | 'all')[] = ['all', 'sched', 'mem', 'sync', 'data', 'error', 'sys'];
const NOISE = new Set(['MEM_ACCESS', 'TLB_HIT', 'VAR_READ', 'VAR_WRITE', 'SYSCALL_EXIT']);

function EventLog() {
  const c = useCtl();
  const [cat, setCat] = useState<EventCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const [noise, setNoise] = useState(false);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(200);
  const rows = useMemo(() => {
    const lq = q.toLowerCase();
    return c.fullEvents.filter(e => (cat === 'all' || CATEGORY[e.type] === cat) && (noise || cat !== 'all' || !NOISE.has(e.type)) &&
      (!lq || e.msg.toLowerCase().includes(lq) || e.type.toLowerCase().includes(lq) || `#${e.id}` === lq));
  }, [c.fullEvents, cat, q, noise]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight)); ro.observe(el); return () => ro.disconnect();
  }, []);
  // keep the most recent event before the cursor in view
  const lastIdx = useMemo(() => { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < c.cursor) lo = mid + 1; else hi = mid; } return lo - 1; }, [rows, c.cursor]);
  useEffect(() => {
    const el = box.current; if (!el || !follow) return;
    if (lastIdx < 0) { el.scrollTop = 0; return; }
    const y = lastIdx * ROW;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW * 2) el.scrollTop = Math.max(0, y - el.clientHeight + ROW * 3);
  }, [lastIdx, follow]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 5);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 5);
  return (
    <section className="panel" aria-label="Event log">
      <div className="panel-head">
        <span className="panel-title">Events</span>
        <span className="count">{c.fullEvents.filter(e => e.t < c.cursor).length}/{c.fullEvents.length}</span>
        <span className="spacer" />
        <div className="filters">
          {CATS.map(k => <button key={k} className={`chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{k !== 'all' && <i style={{ background: CATEGORY_COLOR[k] }} />}{k}</button>)}
        </div>
      </div>
      <div className="panel-head" style={{ height: 32, gap: 10 }}>
        <input className="input search" placeholder="filter…" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter events" />
        <label className="toggle" title="Show memory accesses, TLB hits and variable reads/writes"><input type="checkbox" checked={noise} onChange={e => setNoise(e.target.checked)} />all accesses</label>
        <label className="toggle"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />follow cursor</label>
      </div>
      <div className="panel-body events" ref={box} onScroll={e => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((e, i) => (
            <div key={e.id} className={`ev ${e.t >= c.cursor ? 'future' : ''} ${c.selectedEvent === e.id ? 'sel' : ''}`}
              style={{ position: 'absolute', top: (first + i) * ROW, left: 0, right: 0 }}
              onClick={() => { c.pause(); c.selectEvent(e.id); }} title={e.msg}>
              <span className="id">#{e.id}</span>
              <span className="t">t={e.t}</span>
              <span className="ty" style={{ color: CATEGORY_COLOR[CATEGORY[e.type] ?? 'sys'] }}>{e.type}</span>
              <span className="msg">{e.tid !== undefined && <span style={{ color: threadColor(e.tid) }}>● </span>}{e.msg}</span>
            </div>
          ))}
        </div>
        {rows.length === 0 && <div className="empty">No events match.</div>}
      </div>
    </section>
  );
}

function Terminal() {
  const c = useCtl();
  const [line, setLine] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [c.term.length, c.version]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('kc:focus-terminal', focus);
    return () => window.removeEventListener('kc:focus-terminal', focus);
  }, []);
  return (
    <section className="panel" aria-label="Terminal">
      <div className="panel-head"><span className="panel-title">Terminal</span><span className="spacer" /><span className="faint" style={{ fontSize: 11 }}><kbd>`</kbd> focus · <kbd>↑</kbd> history</span></div>
      <div className="panel-body terminal" ref={body} onClick={() => input.current?.focus()}>
        {c.term.map((l, i) => <div key={i} className={`term-line ${l.kind}`}>{l.text}</div>)}
      </div>
      <form className="term-input" onSubmit={e => { e.preventDefault(); if (!line.trim()) return; execCommand(c, line); setHist(h => [...h.filter(x => x !== line), line].slice(-100)); setHi(-1); setLine(''); }}>
        <span>❯</span>
        <input ref={input} value={line} onChange={e => setLine(e.target.value)} placeholder="help · ps · step 5 · explain 12 · kill 1 · set quantum=6" aria-label="Terminal command" spellCheck={false} autoCapitalize="off"
          onKeyDown={e => {
            if (e.key === 'ArrowUp') { e.preventDefault(); const n = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1); if (hist[n] !== undefined) { setHi(n); setLine(hist[n]); } }
            if (e.key === 'ArrowDown') { e.preventDefault(); if (hi < 0) return; const n = hi + 1; if (n >= hist.length) { setHi(-1); setLine(''); } else { setHi(n); setLine(hist[n]); } }
            if (e.key === 'Escape') input.current?.blur();
          }} />
      </form>
    </section>
  );
}

export function Bottom() {
  return <div className="area-bottom bottom"><Terminal /><EventLog /></div>;
}
