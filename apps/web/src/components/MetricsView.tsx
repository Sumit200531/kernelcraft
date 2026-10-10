import { useMemo } from 'react';
import { computeMetrics, runToEnd, type SchedulerKind } from '@kernelcraft/engine';
import { useCtl } from '../lib/use';
import { threadColor, STATE_COLOR } from '../lib/colors';

const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(d));

export function MetricsView() {
  const c = useCtl();
  const m = c.machine;
  // what-if matrix: the same workload under every scheduler (real runs)
  const matrix = useMemo(() => {
    if (!c.session) return [];
    const w = c.session.workload;
    const variants: { label: string; scheduler: SchedulerKind; preempt?: boolean }[] = [
      { label: 'FCFS', scheduler: 'fcfs' }, { label: 'SJF', scheduler: 'sjf' }, { label: 'SRTF', scheduler: 'srtf' },
      { label: 'Priority', scheduler: 'priority', preempt: false }, { label: 'Priority (preempt)', scheduler: 'priority', preempt: true }, { label: `RR q=${w.config.quantum}`, scheduler: 'rr' }
    ];
    return variants.map(v => {
      const run = runToEnd({ ...w, config: { ...w.config, scheduler: v.scheduler, ...(v.preempt !== undefined ? { preempt: v.preempt } : {}) } }, c.inputs);
      const mt = computeMetrics(run);
      const current = w.config.scheduler === v.scheduler && (v.preempt === undefined || v.preempt === w.config.preempt);
      return { ...v, current, status: run.s.status, ticks: mt.ticks, avgWaiting: mt.avgWaiting, avgTurnaround: mt.avgTurnaround, avgResponse: mt.avgResponse, switches: mt.contextSwitches };
    });
  }, [c.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m) return <div className="empty">Run a workload first.</div>;
  const met = computeMetrics(m);
  const maxW = Math.max(1, ...matrix.map(r => r.avgWaiting ?? 0));
  return (
    <div className="metrics">
      <div className="card">
        <div className="stat-row">
          <div className="stat"><div className="v">{met.completed}/{met.threads.length}</div><div className="k">completed</div></div>
          <div className="stat"><div className="v">{f(met.avgWaiting)}</div><div className="k">avg waiting</div></div>
          <div className="stat"><div className="v">{f(met.avgTurnaround)}</div><div className="k">avg turnaround</div></div>
          <div className="stat"><div className="v">{f(met.avgResponse)}</div><div className="k">avg response</div></div>
          <div className="stat"><div className="v">{f(met.throughput)}</div><div className="k">done / 100 ticks</div></div>
          <div className="stat"><div className="v">{met.cpuUtilization.map(u => (u * 100).toFixed(0) + '%').join(' ')}</div><div className="k">CPU utilisation</div></div>
          <div className="stat"><div className="v">{met.contextSwitches}</div><div className="k">switches ({(met.switchOverhead * 100).toFixed(0)}%)</div></div>
          <div className="stat"><div className="v">{met.preemptions}</div><div className="k">preemptions</div></div>
        </div>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h4>Threads at t={m.s.tick}</h4>
        <table className="table">
          <thead><tr><th>tid</th><th>thread</th><th>state</th><th className="num">prio</th><th className="num">arrive</th><th className="num">first run</th><th className="num">finish</th><th className="num">turnaround</th><th className="num">waiting</th><th className="num">response</th><th className="num">cpu</th><th className="num">blocked</th><th className="num">faults</th><th>time split</th></tr></thead>
          <tbody>
            {met.threads.map(t => {
              const tot = Math.max(1, t.cpu + t.waiting + t.blocked);
              const th = m.s.threads[t.tid];
              return (
                <tr key={t.tid} className={c.selectedTid === t.tid ? 'sel' : ''} onClick={() => c.selectThread(t.tid)}>
                  <td>{t.tid}</td>
                  <td style={{ color: threadColor(t.tid), fontWeight: 600 }}>{t.name}</td>
                  <td><span className="state-tag"><i style={{ background: STATE_COLOR[t.state] }} />{t.state}{t.state === 'terminated' && t.exitCode ? ` (${t.exitCode})` : ''}</span></td>
                  <td className="num">{th.effPriority !== th.basePriority ? <span style={{ color: '#fbbf24' }}>{th.basePriority}→{th.effPriority}</span> : t.priority}</td>
                  <td className="num">{t.arrive}</td><td className="num">{t.firstRun >= 0 ? t.firstRun : '—'}</td><td className="num">{t.finish >= 0 ? t.finish : '—'}</td>
                  <td className="num">{f(t.turnaround)}</td><td className="num">{t.waiting}</td><td className="num">{f(t.response)}</td>
                  <td className="num">{t.cpu}</td><td className="num">{t.blocked}</td><td className="num">{t.faults}</td>
                  <td><div className="split-bar" title={`cpu ${t.cpu} · waiting ${t.waiting} · blocked ${t.blocked}`}>
                    <span style={{ width: `${(t.cpu / tot) * 100}%`, background: threadColor(t.tid) }} />
                    <span style={{ width: `${(t.waiting / tot) * 100}%`, background: '#64748b' }} />
                    <span style={{ width: `${(t.blocked / tot) * 100}%`, background: '#f59e0b' }} />
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>Waiting = ticks spent ready (including context-switch time). Averages use threads that exited normally. Bars: cpu · waiting · blocked.</div>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h4>Scheduler comparison <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>— this workload re-run under each policy (same inputs)</span></h4>
        <table className="table">
          <thead><tr><th>scheduler</th><th>outcome</th><th className="num">ticks</th><th className="num">avg waiting</th><th style={{ width: '30%' }} /><th className="num">avg turnaround</th><th className="num">avg response</th><th className="num">switches</th><th /></tr></thead>
          <tbody>
            {matrix.map(r => (
              <tr key={r.label} className={r.current ? 'sel' : ''} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 600 }}>{r.label}{r.current && <span className="faint"> (current)</span>}</td>
                <td style={{ color: r.status === 'done' ? '#4ade80' : '#f87171' }}>{r.status}</td>
                <td className="num">{r.ticks}</td><td className="num">{f(r.avgWaiting)}</td>
                <td><div className="bar"><span style={{ width: `${((r.avgWaiting ?? 0) / maxW) * 100}%`, background: r.current ? 'var(--accent)' : '#475569' }} /></div></td>
                <td className="num">{f(r.avgTurnaround)}</td><td className="num">{f(r.avgResponse)}</td><td className="num">{r.switches}</td>
                <td>{!r.current && <button className="btn sm" onClick={() => c.applyPatch({ scheduler: r.scheduler, ...(r.preempt !== undefined ? { preempt: r.preempt } : {}) })}>Use</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
