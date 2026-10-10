import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent, type KeyboardEvent } from 'react';
import { useCtl } from '../lib/use';
import { threadColor } from '../lib/colors';

const KW = new Set(['config', 'mutex', 'sem', 'shared', 'process', 'thread', 'repeat', 'end']);
const OPS = new Set(['compute', 'syscall', 'io', 'sleep', 'getpid', 'yield', 'exit']);
const SYNC = new Set(['lock', 'unlock', 'wait', 'signal']);
const MEM = new Set(['load', 'store', 'inc', 'dec', 'atomic_inc', 'atomic_dec']);

function highlight(line: string, bad: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const ci = (() => { const h = line.indexOf('#'); const s = line.indexOf('//'); return [h, s].filter(x => x >= 0).sort((a, b) => a - b)[0] ?? -1; })();
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const re = /(\s+)|([A-Za-z_][\w]*)(=)(\S*)|(0x[0-9a-fA-F]+|\d+k?)|([A-Za-z_][\w.]*)|(\S)/g;
  let m: RegExpExecArray | null, first = true, prev = '', k = 0;
  while ((m = re.exec(code))) {
    if (m[1]) { out.push(m[1]); continue; }
    if (m[2]) {
      out.push(<span key={k++} className="tk-key">{m[2]}</span>, '=', <span key={k++} className={/^(0x[0-9a-f]+|\d+)$/i.test(m[4]) ? 'tk-num' : 'tk-op'}>{m[4]}</span>);
    } else if (m[5]) out.push(<span key={k++} className="tk-num">{m[5]}</span>);
    else if (m[6]) {
      const w = m[6];
      const cls = first ? (KW.has(w) ? 'tk-kw' : OPS.has(w) ? 'tk-op' : SYNC.has(w) ? 'tk-sync' : MEM.has(w) ? 'tk-mem' : '') : (prev === 'process' || prev === 'thread' ? 'tk-name' : prev === 'syscall' ? 'tk-op' : '');
      out.push(cls ? <span key={k++} className={cls}>{w}</span> : w);
      prev = first ? w : prev;
    } else out.push(m[7]);
    first = false;
  }
  if (ci >= 0) out.push(<span key={k++} className="tk-com">{line.slice(ci)}</span>);
  return bad ? [<span key="e" className="tk-err">{out}</span>] : out;
}

export function Editor() {
  const c = useCtl();
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gut = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const lines = useMemo(() => c.source.split('\n'), [c.source]);
  const diagByLine = useMemo(() => {
    const m = new Map<number, 'error' | 'warning'>();
    for (const d of c.diagnostics) if (m.get(d.line) !== 'error') m.set(d.line, d.severity);
    return m;
  }, [c.diagnostics]);
  const highlighted = useMemo(() => lines.map((l, i) => <div key={i}>{highlight(l, diagByLine.get(i + 1) === 'error')}{'\n'}</div>), [lines, diagByLine]);

  // program counters of live threads at the cursor (only when the editor matches the run)
  const pcs = new Map<number, { tid: number; running: boolean }[]>();
  const m = c.machine;
  if (m && !c.dirty) for (const t of m.s.threads) {
    if (t.state === 'terminated' || t.state === 'new') continue;
    const line = m.ops[t.tid][t.pc]?.line;
    if (line) pcs.set(line, [...(pcs.get(line) ?? []), { tid: t.tid, running: t.state === 'running' }]);
  }
  const ev = c.selectedEvent !== null ? c.fullEvents[c.selectedEvent] : null;
  const hlLine = ev?.line ?? (c.selectedTid !== null && m ? m.ops[c.selectedTid]?.[m.s.threads[c.selectedTid]?.pc]?.line : undefined);

  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    if (pre.current) { pre.current.scrollTop = t.scrollTop; pre.current.scrollLeft = t.scrollLeft; }
    if (gut.current) gut.current.style.transform = `translateY(${-t.scrollTop}px)`;
    setScroll(t.scrollTop);
  };
  useEffect(() => {
    // keep the highlighted line in view when an event is selected
    if (!hlLine || !ta.current) return;
    const y = (hlLine - 1) * 20;
    const t = ta.current;
    if (y < t.scrollTop || y > t.scrollTop + t.clientHeight - 40) { t.scrollTop = Math.max(0, y - t.clientHeight / 3); sync({ currentTarget: t } as UIEvent<HTMLTextAreaElement>); }
  }, [hlLine, c.selectedEvent]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); c.run({ inputs: c.dirty ? [] : c.inputs, cursor: 'end' }); return; }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const t = e.currentTarget, s = t.selectionStart, en = t.selectionEnd;
      const v = t.value.slice(0, s) + '  ' + t.value.slice(en);
      c.setSource(v);
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
    }
  };
  const goLine = (line: number) => {
    const t = ta.current; if (!t) return;
    const idx = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    t.focus(); t.selectionStart = t.selectionEnd = idx;
    t.scrollTop = Math.max(0, (line - 1) * 20 - t.clientHeight / 3);
  };
  const errs = c.diagnostics;

  return (
    <section className="panel area-editor" aria-label="Workload editor">
      <div className="panel-head">
        <span className="panel-title">Workload</span>
        <span className="faint mono" style={{ fontSize: 11 }}>{c.sampleId ? `${c.sampleId}.kc` : 'custom.kc'}</span>
        <span className="spacer" />
        {errs.length > 0 && <span className={`count ${errs.some(d => d.severity === 'error') ? 'bad' : 'warn'}`}>{errs.length} {errs.some(d => d.severity === 'error') ? 'error' : 'warning'}{errs.length > 1 ? 's' : ''}</span>}
        <span className="faint" style={{ fontSize: 11 }}><kbd>Ctrl</kbd> <kbd>↵</kbd> run</span>
      </div>
      <div className="editor">
        <div className="gutter" aria-hidden>
          <div className="gutter-inner" ref={gut}>
            {lines.map((_, i) => {
              const d = diagByLine.get(i + 1);
              const p = pcs.get(i + 1);
              return (
                <div key={i} className={`gl${d === 'error' ? ' err' : d === 'warning' ? ' warn' : ''}${p ? ' active' : ''}`}>
                  {p && !d && <span className="pc-dots">{p.slice(0, 4).map(x => <span key={x.tid} className={`pc-dot${x.running ? ' run' : ''}`} style={{ background: threadColor(x.tid), color: threadColor(x.tid) }} title={m!.s.threads[x.tid].name} />)}</span>}
                  {i + 1}
                </div>
              );
            })}
          </div>
        </div>
        <div className="code">
          {hlLine && <div className="line-hl" style={{ top: 10 + (hlLine - 1) * 20 - scroll, background: 'rgba(94,234,212,.07)', boxShadow: 'inset 2px 0 0 var(--accent)' }} />}
          {[...pcs].map(([line, ts]) => (
            <div key={line} className="line-hl" style={{ top: 10 + (line - 1) * 20 - scroll, background: ts.some(x => x.running) ? `${threadColor(ts.find(x => x.running)!.tid)}14` : 'transparent' }} />
          ))}
          <pre ref={pre} aria-hidden>{highlighted}</pre>
          <textarea ref={ta} value={c.source} spellCheck={false} autoCapitalize="off" autoComplete="off" aria-label="Workload source"
            onChange={e => c.setSource(e.target.value)} onScroll={sync} onKeyDown={onKey} />
        </div>
      </div>
      {errs.length > 0 && (
        <div className="diag-bar">
          {errs.map((d, i) => (
            <div key={i} className={`diag ${d.severity}`} onClick={() => goLine(d.line)}>
              <span className="sev">{d.severity === 'error' ? '✖' : '▲'}</span><span className="where">{d.line}:{d.col}</span><span>{d.message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
