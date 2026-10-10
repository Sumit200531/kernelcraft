import { useEffect, useRef, useState } from 'react';
import type { Finding } from '@kernelcraft/engine';
import { useCtl } from '../lib/use';
import { threadColor, CATEGORY, CATEGORY_COLOR, STATE_COLOR } from '../lib/colors';
import { RichText, EvRef } from './RichText';
import { ISend, ICheck, ISpark } from './Icons';

function FindingCard({ f }: { f: Finding }) {
  const c = useCtl();
  const r = f.experiment?.result;
  const fmt = (v: number | null) => (v === null ? 'n/a' : Number.isInteger(v) ? String(v) : v.toFixed(2));
  return (
    <article className={`finding ${f.severity}`}>
      <h3><span className={`sev ${f.severity}`}>{f.severity}</span><span>{f.title}</span></h3>
      <div className="fp"><RichText text={f.detail} /></div>
      <div className="evidence">
        <span className="faint" style={{ fontSize: 11, marginRight: 2 }}>evidence</span>
        {f.evidence.slice(0, 12).map(id => <EvRef key={id} id={id} />)}
        {f.evidence.length > 12 && <span className="faint" style={{ fontSize: 11 }}>+{f.evidence.length - 12}</span>}
        {f.lines.length > 0 && <span className="faint" style={{ fontSize: 11, marginLeft: 6 }}>lines {f.lines.join(', ')}</span>}
      </div>
      <div className="fp" style={{ marginBottom: 0, display: 'flex', gap: 4 }}><span style={{ color: 'var(--accent-2)', fontWeight: 600, flex: 'none' }}>Fix ·</span><RichText text={f.advice} /></div>
      {f.experiment && (
        <div className="experiment">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ISpark />
            <span className="label">What if: {f.experiment.label}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => c.applyExperiment(f.experiment!)} title="Apply this change to the workload and re-run">Apply</button>
          </div>
          <div className="faint" style={{ fontSize: 11.5, margin: '4px 0' }}>{f.experiment.hypothesis}</div>
          {r && (
            <>
              <div className={`verdict ${r.improved ? 'yes' : 'no'}`}>{r.improved ? <><ICheck /> Confirmed by re-running</> : 'Not confirmed by re-running'}</div>
              {r.deltas.map(d => {
                const better = d.before !== null && d.after !== null && (d.better === 'lower' ? d.after < d.before : d.after > d.before);
                const worse = d.before !== null && d.after !== null && (d.better === 'lower' ? d.after > d.before : d.after < d.before);
                return (
                  <div key={d.key} className="delta">
                    <span className="dim" style={{ fontFamily: 'var(--sans)', fontSize: 12 }}>{d.label}</span>
                    <span>{fmt(d.before)}</span><span className="arrow">→</span>
                    <span className={better ? 'better' : worse ? 'worse' : ''}>{fmt(d.after)}</span>
                  </div>
                );
              })}
              {r.statusBefore !== r.statusAfter && <div className="delta"><span className="dim" style={{ fontFamily: 'var(--sans)', fontSize: 12 }}>run outcome</span><span>{r.statusBefore}</span><span className="arrow">→</span><span className="better">{r.statusAfter}</span></div>}
              <div className="faint mono" style={{ fontSize: 10.5, marginTop: 4 }}>trace {r.hashBefore} → {r.hashAfter}</div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function Findings() {
  const c = useCtl();
  const a = c.analysis;
  if (!a) return <div className="empty">Run a workload to analyse it.</div>;
  return (
    <div className="findings">
      <div className="dim" style={{ fontSize: 12.5 }}>{a.headline}</div>
      {a.findings.length === 0 && (
        <div className="empty"><div className="big">✓</div>No deadlocks, races, crashes or performance pathologies found.<br />Try another sample, or ask the assistant about a thread.</div>
      )}
      {a.findings.map(f => <FindingCard key={f.id} f={f} />)}
    </div>
  );
}

function Assistant() {
  const c = useCtl();
  const [q, setQ] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { if (c.chatFocusTick) inp.current?.focus(); }, [c.chatFocusTick]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [c.chat.length, c.version]);
  const m = c.full;
  const slowest = m ? [...m.s.threads].sort((a, b) => (b.readyTicks + b.blockedTicks) - (a.readyTicks + a.blockedTicks))[0] : null;
  const suggestions = [
    m && (m.s.status === 'deadlock' || m.s.status === 'stalled') ? 'Why is it stuck?' : 'Summarise this run',
    slowest ? `Why is ${slowest.name.replace('.main', '')} slow?` : null,
    c.analysis?.findings.some(f => f.kind === 'race') ? 'Why is the counter wrong?' : 'Why so many page faults?',
    'What should I try?',
    `What happened at t=${Math.max(0, c.cursor - 1)}?`
  ].filter(Boolean) as string[];
  const send = (text: string) => { const t = text.trim(); if (!t) return; void c.ask(t); setQ(''); };
  const llm = c.health?.narration === 'llm';
  return (
    <div className="chat">
      <div className="chat-log" ref={log}>
        {c.chat.length === 0 && (
          <div className="msg assistant">
            <RichText text={`I answer from this run's trace only, and cite events as chips you can click. ${c.analysis ? c.analysis.headline : ''}\nAsk about a thread by name, a tick (\`t=12\`), an event (\`#42\`), or a symptom.`} />
          </div>
        )}
        {c.chat.map((msg, i) => (
          <div key={i} className={`msg ${msg.role}`}>
            {msg.pending ? <span className="typing"><i /><i /><i /></span> : msg.role === 'assistant' ? <RichText text={msg.text} /> : msg.text}
            {msg.role === 'assistant' && !msg.pending && (
              <div className="meta">
                {msg.intent && <span>intent: {msg.intent}</span>}
                <span>{msg.model ? `narrated by ${msg.model} · citations verified` : 'deterministic · trace-derived'}</span>
                {msg.note && <span style={{ color: 'var(--warn)' }}>{msg.note}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="suggest">{suggestions.map(s => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(q); }}>
        <input ref={inp} className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Ask about this run…" aria-label="Ask the assistant" maxLength={2000} />
        <button className="btn primary icon" aria-label="Send" disabled={!q.trim()}><ISend /></button>
      </form>
      <div style={{ padding: '0 10px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <label className="toggle" title={llm ? 'Rephrase answers with the configured LLM; citations are validated server-side' : 'Start the API with LLM_BASE_URL set to enable'}>
          <input type="checkbox" checked={c.narrate && llm} disabled={!llm} onChange={e => c.setNarrate(e.target.checked)} /> LLM narration {llm ? '' : '(not configured)'}
        </label>
      </div>
    </div>
  );
}

function Inspector() {
  const c = useCtl();
  const e = c.selectedEvent !== null ? c.fullEvents[c.selectedEvent] : null;
  const m = c.machine;
  const th = c.selectedTid !== null && m ? m.s.threads[c.selectedTid] : null;
  return (
    <div className="inspector">
      {e ? (
        <div className="card">
          <h4><span style={{ color: CATEGORY_COLOR[CATEGORY[e.type] ?? 'sys'] }}>{e.type}</span><span className="spacer" /><span className="mono faint" style={{ textTransform: 'none' }}>#{e.id} · t={e.t}{e.core !== undefined ? ` · core ${e.core}` : ''}{e.line ? ` · line ${e.line}` : ''}</span></h4>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{e.msg}</div>
          {c.explanation && <RichText text={c.explanation.text} />}
          {e.data && Object.keys(e.data).length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="faint" style={{ cursor: 'pointer', fontSize: 11.5 }}>raw event data</summary>
              <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0', color: 'var(--text-2)' }}>{JSON.stringify(e.data, null, 1)}</pre>
            </details>
          )}
        </div>
      ) : <div className="card faint" style={{ fontSize: 12 }}>Click an event in the log, a marker on the timeline, or an evidence chip to inspect it.</div>}
      {th && m && (
        <div className="card">
          <h4><span style={{ color: threadColor(th.tid), textTransform: 'none', fontSize: 13, letterSpacing: 0 }}>{th.name}</span><span className="spacer" /><span className="state-tag"><i style={{ background: STATE_COLOR[th.state] }} />{th.state}</span></h4>
          <dl className="kv">
            <dt>tid / pid</dt><dd>{th.tid} / {th.pid} ({m.s.processes[th.pid].name})</dd>
            <dt>priority</dt><dd>{th.basePriority}{th.effPriority !== th.basePriority ? ` → effective ${th.effPriority}` : ''}</dd>
            <dt>pc</dt><dd>{th.state === 'terminated' ? `exited (code ${th.exitCode})` : `op ${th.pc + 1}/${m.ops[th.tid].length} · line ${m.ops[th.tid][th.pc]?.line ?? '—'} · ${m.ops[th.tid][th.pc]?.k ?? ''}`}</dd>
            <dt>waiting on</dt><dd>{!th.block ? '—' : th.block.kind === 'lock' ? `mutex ${th.block.m}` : th.block.kind === 'sem' ? `semaphore ${th.block.s}` : th.block.kind === 'fault' ? `page ${th.block.vpn} until t=${th.block.until}` : `${th.block.kind} until t=${th.block.until}`}</dd>
            <dt>holds</dt><dd>{th.held.join(', ') || '—'}</dd>
            <dt>register</dt><dd>{th.reg}</dd>
            <dt>cpu / ready / blocked</dt><dd>{th.cpuTicks} / {th.readyTicks + th.switchTicks} / {th.blockedTicks}</dd>
            <dt>page faults</dt><dd>{th.faults}</dd>
          </dl>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => void c.ask(`why is ${th.name} slow?`)}>Ask about it</button>
            <button className="btn sm" disabled={th.state === 'terminated'} onClick={() => { const err = c.inject({ type: 'kill', tid: th.tid }); c.toast(err ?? `Killed ${th.name} at t=${c.cursor - 1}; future re-simulated`); }}>Kill at t={c.cursor}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SidePanel() {
  const c = useCtl();
  const n = c.analysis?.findings.length ?? 0;
  const crit = c.analysis?.findings.some(f => f.severity === 'critical');
  return (
    <section className="panel area-side" aria-label="Analysis">
      <div className="panel-head" style={{ padding: '0 4px' }}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={c.side === 'findings'} className={`tab ${c.side === 'findings' ? 'on' : ''}`} onClick={() => c.setSide('findings')}>Findings {n > 0 && <span className={`count ${crit ? 'bad' : 'warn'}`}>{n}</span>}</button>
          <button role="tab" aria-selected={c.side === 'assistant'} className={`tab ${c.side === 'assistant' ? 'on' : ''}`} onClick={() => c.setSide('assistant')}>Assistant</button>
          <button role="tab" aria-selected={c.side === 'inspector'} className={`tab ${c.side === 'inspector' ? 'on' : ''}`} onClick={() => c.setSide('inspector')}>Inspector</button>
        </div>
      </div>
      <div className="panel-body" style={c.side === 'assistant' ? { overflow: 'hidden' } : undefined}>
        {c.side === 'findings' ? <Findings /> : c.side === 'assistant' ? <Assistant /> : <Inspector />}
      </div>
    </section>
  );
}
