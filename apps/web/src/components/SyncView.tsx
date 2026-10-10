import { useCtl } from '../lib/use';
import { threadColor } from '../lib/colors';

export function SyncView() {
  const c = useCtl();
  const m = c.machine;
  if (!m) return <div className="empty">Run a workload first.</div>;
  const s = m.s;
  const mutexes = Object.values(s.mutexes), sems = Object.values(s.sems), vars = Object.values(s.vars);
  const W = 520, H = 340, cx = W / 2, cy = H / 2;
  const T = s.threads;
  const R = [...mutexes.map(x => ({ kind: 'mutex' as const, name: x.name })), ...sems.map(x => ({ kind: 'sem' as const, name: x.name }))];
  const tpos = T.map((_, i) => { const a = -Math.PI / 2 + (i / Math.max(1, T.length)) * Math.PI * 2; return { x: cx + Math.cos(a) * (W / 2 - 70), y: cy + Math.sin(a) * (H / 2 - 34) }; });
  const rpos = R.map((_, i) => { const a = -Math.PI / 2 + ((i + 0.5) / Math.max(1, R.length)) * Math.PI * 2; const r = R.length === 1 ? 0 : 0.42; return { x: cx + Math.cos(a) * (W / 2 - 70) * r, y: cy + Math.sin(a) * (H / 2 - 34) * r }; });
  const ridx = (kind: string, name: string) => R.findIndex(r => r.kind === kind && r.name === name);
  const cycle = new Set<string>();
  if (s.deadlock) s.deadlock.tids.forEach((tid, i) => {
    const res = s.deadlock!.resources[i];
    cycle.add(`w${tid}-${res}`);
    const owner = s.mutexes[res]?.owner;
    if (owner !== undefined) cycle.add(`h${res}-${owner}`);
  });
  type Edge = { id: string; from: { x: number; y: number }; to: { x: number; y: number }; kind: 'hold' | 'wait' };
  const edges: Edge[] = [];
  for (const mx of mutexes) if (mx.owner >= 0) edges.push({ id: `h${mx.name}-${mx.owner}`, from: rpos[ridx('mutex', mx.name)], to: tpos[mx.owner], kind: 'hold' });
  for (const th of T) {
    for (const h of th.held) if (s.sems[h]) edges.push({ id: `h${h}-${th.tid}`, from: rpos[ridx('sem', h)], to: tpos[th.tid], kind: 'hold' });
    if (th.state === 'blocked' && th.block?.kind === 'lock') edges.push({ id: `w${th.tid}-${th.block.m}`, from: tpos[th.tid], to: rpos[ridx('mutex', th.block.m)], kind: 'wait' });
    if (th.state === 'blocked' && th.block?.kind === 'sem') edges.push({ id: `w${th.tid}-${th.block.s}`, from: tpos[th.tid], to: rpos[ridx('sem', th.block.s)], kind: 'wait' });
  }
  const shorten = (a: { x: number; y: number }, b: { x: number; y: number }, r1: number, r2: number) => {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    return { x1: a.x + (dx / d) * r1, y1: a.y + (dy / d) * r1, x2: b.x - (dx / d) * r2, y2: b.y - (dy / d) * r2 };
  };

  return (
    <div className="sync">
      <div className="card">
        <h4>Resource-allocation graph <span className="spacer" />
          {s.deadlock ? <span className="sev critical">cycle: deadlock</span> : s.status === 'stalled' ? <span className="sev critical">stalled</span> : <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>t={s.tick}</span>}
        </h4>
        {R.length === 0 ? <div className="empty">This workload has no mutexes or semaphores.</div> : (
          <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Resource allocation graph">
            <defs>
              {(['hold', 'wait', 'cycle'] as const).map(k => (
                <marker key={k} id={`ar-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill={k === 'hold' ? '#3d5068' : k === 'wait' ? '#fbbf24' : '#f87171'} />
                </marker>
              ))}
            </defs>
            {edges.map(e => {
              const isCycle = cycle.has(e.id);
              const l = shorten(e.from, e.to, e.kind === 'hold' ? 16 : 20, e.kind === 'hold' ? 20 : 16);
              const k = isCycle ? 'cycle' : e.kind;
              return <line key={e.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={`edge ${k}`} markerEnd={`url(#ar-${k})`} />;
            })}
            {R.map((r, i) => {
              const p = rpos[i];
              const mx = r.kind === 'mutex' ? s.mutexes[r.name] : null;
              const sm = r.kind === 'sem' ? s.sems[r.name] : null;
              const busy = mx ? mx.owner >= 0 : sm!.value === 0;
              return (
                <g key={r.name} transform={`translate(${p.x},${p.y})`}>
                  {r.kind === 'mutex'
                    ? <rect x={-19} y={-14} width={38} height={28} rx={6} fill={busy ? '#2a1f12' : '#141b25'} stroke={busy ? '#fbbf24' : '#3d5068'} strokeWidth={1.6} />
                    : <path d="M0 -18L18 0L0 18L-18 0z" fill="#141b25" stroke={busy ? '#fb923c' : '#3d5068'} strokeWidth={1.6} />}
                  <text textAnchor="middle" y={4} style={{ fontSize: 10, fontWeight: 700, fill: busy ? '#fbbf24' : '#7d8ea5' }}>{r.kind === 'mutex' ? (busy ? 'held' : 'free') : sm!.value}</text>
                  <text textAnchor="middle" y={30} style={{ fill: '#c3cdd9', fontWeight: 600 }}>{r.name}</text>
                </g>
              );
            })}
            {T.map((th, i) => {
              const p = tpos[i];
              const col = threadColor(th.tid);
              const dead = th.state === 'terminated';
              const inCycle = s.deadlock?.tids.includes(th.tid);
              return (
                <g key={th.tid} className="node" transform={`translate(${p.x},${p.y})`} opacity={dead ? 0.3 : 1} onClick={() => c.selectThread(th.tid)}>
                  {inCycle && <circle r={22} fill="none" stroke="#f87171" strokeWidth={1} opacity={0.6}><animate attributeName="r" values="18;26;18" dur="1.4s" repeatCount="indefinite" /><animate attributeName="opacity" values=".8;0;.8" dur="1.4s" repeatCount="indefinite" /></circle>}
                  <circle r={16} fill={th.state === 'running' ? col : '#0d131b'} stroke={col} strokeWidth={c.selectedTid === th.tid ? 3 : 1.8} />
                  <text textAnchor="middle" y={4} style={{ fontSize: 10, fontWeight: 700, fill: th.state === 'running' ? '#06110f' : col }}>{th.tid}</text>
                  <text textAnchor={p.x < cx - 20 ? 'end' : p.x > cx + 20 ? 'start' : 'middle'} x={p.x < cx - 20 ? -22 : p.x > cx + 20 ? 22 : 0} y={p.x < cx - 20 || p.x > cx + 20 ? 4 : p.y < cy ? -24 : 32} style={{ fontSize: 10.5 }}>{th.name.replace('.main', '')}</text>
                  {th.effPriority !== th.basePriority && <text textAnchor="middle" y={p.y < cy ? 44 : -24} style={{ fontSize: 9.5, fill: '#fbbf24' }}>prio {th.basePriority}→{th.effPriority}</text>}
                </g>
              );
            })}
          </svg>
        )}
        <div className="legend faint" style={{ fontSize: 11, display: 'flex', gap: 14, marginTop: 4 }}>
          <span>▢ mutex</span><span>◇ semaphore (value)</span><span style={{ color: '#7d8ea5' }}>→ holds</span><span style={{ color: '#fbbf24' }}>⇢ waits for</span><span style={{ color: '#f87171' }}>⇢ cycle</span>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <div className="card" style={{ overflowX: 'auto' }}>
          <h4>Mutexes</h4>
          {mutexes.length === 0 ? <div className="faint" style={{ fontSize: 12 }}>none</div> : (
            <table className="table"><thead><tr><th>name</th><th>owner</th><th>waiters</th><th className="num">acq</th><th className="num">contended</th></tr></thead>
              <tbody>{mutexes.map(x => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  <td style={{ color: x.owner >= 0 ? threadColor(x.owner) : undefined }}>{x.owner >= 0 ? T[x.owner].name.replace('.main', '') : <span className="faint">free</span>}</td>
                  <td>{x.waiters.map(w => <span key={w} style={{ color: threadColor(w), marginRight: 6 }}>{T[w].name.replace('.main', '')}</span>)}</td>
                  <td className="num">{x.acquisitions}</td><td className="num">{x.contentions}</td>
                </tr>
              ))}</tbody></table>
          )}
        </div>
        {sems.length > 0 && (
          <div className="card">
            <h4>Semaphores</h4>
            {sems.map(x => (
              <div key={x.name} className="var-row">
                <span className="mono" style={{ width: 70 }}>{x.name}</span>
                <span className="mono" style={{ width: 54 }}>{x.value} / {Math.max(x.initial, x.value)}</span>
                <div className="bar"><span style={{ width: `${(x.value / Math.max(1, x.initial, x.value)) * 100}%`, background: x.value ? '#fb923c' : 'transparent' }} /></div>
                <span style={{ fontSize: 11.5, minWidth: 80 }}>{x.waiters.length ? x.waiters.map(w => <span key={w} style={{ color: threadColor(w), marginRight: 4 }}>{T[w].name.replace('.main', '')}</span>) : <span className="faint">no waiters</span>}</span>
              </div>
            ))}
          </div>
        )}
        <div className="card">
          <h4>Shared variables</h4>
          {vars.length === 0 ? <div className="faint" style={{ fontSize: 12 }}>none</div> : vars.map(v => {
            const exp = v.initial + v.expectedDelta;
            const lost = exp - v.value;
            return (
              <div key={v.name} className="var-row">
                <span className="mono" style={{ width: 70 }}>{v.name}</span>
                <span className="mono" style={{ width: 92, color: lost ? '#f87171' : '#4ade80' }}>{v.value} <span className="faint">/ {exp}</span></span>
                <div className="bar"><span style={{ width: `${exp ? (v.value / exp) * 100 : 100}%`, background: lost ? 'linear-gradient(90deg,#a78bfa,#f87171)' : '#4ade80' }} /></div>
                <span className={`sev ${v.raceReported ? 'critical' : 'info'}`} title={`Eraser lockset state: ${v.lsState}${v.lockset ? `; candidate locks {${v.lockset.join(', ')}}` : ''}`}>{v.raceReported ? 'race' : v.lsState}</span>
              </div>
            );
          })}
          {vars.some(v => v.raceReported) && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Value / expected counts every completed increment. The gap is exactly the updates destroyed by stale writes (see LOST_UPDATE events).</div>}
        </div>
      </div>
    </div>
  );
}
