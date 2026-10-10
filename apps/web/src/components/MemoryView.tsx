import { useMemo, useState } from 'react';
import { computeMetrics } from '@kernelcraft/engine';
import { useCtl } from '../lib/use';
import { pidColor } from '../lib/colors';

export function MemoryView() {
  const c = useCtl();
  const m = c.machine;
  const [pid, setPid] = useState(0);
  const faultsPerTick = useMemo(() => {
    const arr = new Array(Math.max(1, c.fullTicks.length)).fill(0);
    for (const e of c.fullEvents) if (e.type === 'PAGE_FAULT' && e.t < arr.length) arr[e.t]++;
    return arr;
  }, [c.fullEvents, c.fullTicks]);
  if (!m) return <div className="empty">Run a workload first.</div>;
  const s = m.s, cfg = s.config;
  const met = computeMetrics(m);
  const last = m.visibleEvents().filter(e => e.t === s.tick - 1);
  const faulted = new Set(last.filter(e => e.type === 'PAGE_FAULT').map(e => e.data!.frame as number));
  const evicted = new Set(last.filter(e => e.type === 'PAGE_EVICT').map(e => e.data!.frame as number));
  const hit = new Set(last.filter(e => e.type === 'MEM_ACCESS').map(e => e.data!.frame as number));
  const proc = s.processes[Math.min(pid, s.processes.length - 1)];
  const memProcs = s.processes;

  // fault sparkline: buckets across the whole run
  const B = Math.min(120, faultsPerTick.length);
  const per = faultsPerTick.length / B;
  const buckets = Array.from({ length: B }, (_, i) => { let v = 0; for (let t = Math.floor(i * per); t < Math.floor((i + 1) * per); t++) v += faultsPerTick[t]; return v; });
  const maxB = Math.max(1, ...buckets);
  const curX = (s.tick / Math.max(1, faultsPerTick.length)) * 100;

  return (
    <div className="mem">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="stat-row">
          <div className="stat"><div className="v">{met.memAccesses}</div><div className="k">accesses</div></div>
          <div className="stat"><div className="v" style={{ color: '#f472b6' }}>{met.pageFaults}</div><div className="k">page faults</div></div>
          <div className="stat"><div className="v">{met.faultRate === null ? '—' : (met.faultRate * 100).toFixed(0) + '%'}</div><div className="k">faults / access</div></div>
          <div className="stat"><div className="v" style={{ color: '#5eead4' }}>{met.tlbHitRate === null ? '—' : (met.tlbHitRate * 100).toFixed(0) + '%'}</div><div className="k">TLB hit rate</div></div>
          <div className="stat"><div className="v">{met.evictions}</div><div className="k">evictions</div></div>
          <div className="stat"><div className="v">{met.writebacks}</div><div className="k">write-backs</div></div>
        </div>
      </div>

      <div className="card">
        <h4>Physical memory <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>{s.frames.filter(f => f.pid >= 0).length}/{cfg.frames} frames · {cfg.replacement.toUpperCase()} · {cfg.pageSize} B pages</span></h4>
        <div className="frames">
          {s.frames.map((f, i) => {
            if (f.pid < 0) return <div key={i} className="frame free"><div className="fno"><span>frame {i}</span></div><div className="fpage faint">free</div><div /></div>;
            const pte = s.processes[f.pid].pageTable[f.vpn];
            const col = pidColor(f.pid);
            const cls = faulted.has(i) ? 'faulted' : evicted.has(i) ? 'evicted' : hit.has(i) ? 'hit' : '';
            const loadPct = f.loading ? Math.min(100, ((s.tick - pte.loadedAt) / Math.max(1, pte.readyAt - pte.loadedAt)) * 100) : 0;
            return (
              <div key={`${i}-${cls ? s.tick : ''}`} className={`frame ${f.loading ? 'loading' : ''} ${cls}`}
                style={{ borderColor: f.loading ? undefined : col + '66', background: `linear-gradient(160deg, ${col}1f, transparent 70%)`, ['--load' as string]: `${loadPct}%` }}
                title={`${s.processes[f.pid].name} page ${f.vpn}${f.loading ? ` (loading until t=${pte.readyAt})` : ` · loaded t=${pte.loadedAt} · last used t=${pte.lastUse}`}`}>
                <div className="fno"><span>frame {i}</span>{f.loading && <span style={{ color: '#f472b6' }}>I/O</span>}</div>
                <div className="fpage" style={{ color: col }}>{s.processes[f.pid].name}:{f.vpn}</div>
                <div className="bits"><span className={`bit ${pte.ref ? 'on' : ''}`}>R</span><span className={`bit d ${pte.dirty ? 'on' : ''}`}>D</span><span className="bit">{cfg.replacement === 'lru' ? `u${pte.lastUse}` : cfg.replacement === 'fifo' ? `l${pte.loadedAt}` : s.clockHand === i ? '◀' : ''}</span></div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h4>Page faults over time</h4>
        <svg className="spark" viewBox={`0 0 ${B} 40`} preserveAspectRatio="none" aria-label="Page faults per tick">
          {buckets.map((v, i) => <rect key={i} x={i + 0.1} y={40 - (v / maxB) * 38} width={0.8} height={(v / maxB) * 38} fill={i * per < s.tick ? '#f472b6' : '#f472b640'} />)}
          <rect x={(curX / 100) * B - 0.15} y={0} width={0.3} height={40} fill="#5eead4" />
        </svg>
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>Pink bars are faults per {per > 1 ? `${per.toFixed(1)} ticks` : 'tick'}; faded bars are the recorded future.</div>
        <h4 style={{ marginTop: 14 }}>TLB {cfg.tlb ? `· ${cfg.tlb} entries per core · ${cfg.tlbPenalty} tick miss penalty` : '· disabled'}</h4>
        {s.cores.map(core => (
          <div key={core.id} style={{ marginBottom: 6 }}>
            <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>core {core.id}</div>
            <div className="tlb">
              {core.tlb.length ? core.tlb.map((e, i) => <span key={i} className="tlb-entry" style={{ borderColor: pidColor(e.pid) + '55' }}><span style={{ color: pidColor(e.pid) }}>{s.processes[e.pid].name}:{e.vpn}</span> → f{e.frame}</span>) : <span className="faint" style={{ fontSize: 11.5 }}>empty</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Page table <span className="spacer" />
          <span className="proc-tabs">{memProcs.map(p => <button key={p.pid} className={`chip ${p.pid === proc.pid ? 'on' : ''}`} onClick={() => setPid(p.pid)}><i style={{ background: pidColor(p.pid) }} />{p.name}</button>)}</span>
        </h4>
        <table className="pt">
          <thead><tr><th>vpn</th><th>virtual range</th><th>frame</th><th>present</th><th>dirty</th><th>ref</th><th>loaded</th><th>last use</th><th>faults</th></tr></thead>
          <tbody>
            {proc.pageTable.map((e, vpn) => {
              const nf = m.visibleEvents().filter(x => x.type === 'PAGE_FAULT' && x.pid === proc.pid && x.data!.vpn === vpn).length;
              return (
                <tr key={vpn} className={e.present ? 'present' : e.loading ? 'loading' : ''}>
                  <td>{vpn}</td>
                  <td className="faint">0x{(vpn * cfg.pageSize).toString(16).padStart(4, '0')}–0x{((vpn + 1) * cfg.pageSize - 1).toString(16).padStart(4, '0')}</td>
                  <td>{e.frame >= 0 ? e.frame : '—'}</td>
                  <td style={{ color: e.present ? '#5eead4' : e.loading ? '#f472b6' : undefined }}>{e.present ? 'yes' : e.loading ? 'loading' : 'no'}</td>
                  <td style={{ color: e.dirty ? '#f87171' : undefined }}>{e.present ? (e.dirty ? 'yes' : 'no') : ''}</td>
                  <td>{e.present ? (e.ref ? '1' : '0') : ''}</td>
                  <td>{e.loadedAt >= 0 ? `t=${e.loadedAt}` : ''}</td>
                  <td>{e.lastUse >= 0 ? `t=${e.lastUse}` : ''}</td>
                  <td style={{ color: nf > 1 ? '#f472b6' : undefined }}>{nf || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {proc.state === 'terminated' && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>{proc.name} has exited (code {proc.exitCode}); its frames were released.</div>}
      </div>
    </div>
  );
}
