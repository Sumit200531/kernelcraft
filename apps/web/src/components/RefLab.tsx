import { useMemo, useState } from 'react';
import { simulateRefString, faultCurve, parseRefString, type RefPolicy } from '@kernelcraft/engine';

const POLICIES: RefPolicy[] = ['fifo', 'lru', 'clock', 'opt'];
const PCOLOR: Record<RefPolicy, string> = { fifo: '#f472b6', lru: '#5eead4', clock: '#fbbf24', opt: '#a78bfa' };
const PRESETS: [string, string][] = [
  ['Belady (FIFO anomaly)', '1 2 3 4 1 2 5 1 2 3 4 5'],
  ['Textbook (SGG)', '7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1'],
  ['Looping working set', '0 1 2 3 4 0 1 2 3 4 0 1 2 3 4'],
  ['Locality shift', '1 2 1 3 1 2 1 3 7 8 7 9 7 8 7 9']
];

export function RefLab() {
  const [text, setText] = useState(PRESETS[0][1]);
  const [frames, setFrames] = useState(3);
  const [policy, setPolicy] = useState<RefPolicy>('fifo');
  const refs = useMemo(() => parseRefString(text), [text]);
  const valid = refs !== null && refs.length > 0 && refs.length <= 64;
  const res = useMemo(() => (valid ? simulateRefString(refs!, frames, policy) : null), [refs, frames, policy, valid]);
  const maxF = 8;
  const curves = useMemo(() => (valid ? POLICIES.map(p => ({ p, c: faultCurve(refs!, maxF, p) })) : []), [refs, valid]);
  const anomaly = curves.find(x => x.p === 'fifo')?.c.some((v, i, a) => i > 0 && v > a[i - 1]);
  const maxY = Math.max(1, ...curves.flatMap(x => x.c));
  const W = 420, H = 180, PAD = 28;
  const px = (f: number) => PAD + ((f - 1) / (maxF - 1)) * (W - PAD - 10);
  const py = (v: number) => H - PAD - (v / maxY) * (H - PAD - 10);

  return (
    <div className="lab">
      <div className="card">
        <h4>Reference-string lab <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>— the same replacement code the kernel uses (verified against it in 300 randomized tests)</span></h4>
        <div className="lab-controls">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>Page references
            <input className={`input ${valid ? '' : 'bad'}`} value={text} onChange={e => setText(e.target.value)} aria-invalid={!valid} />
          </label>
          <label className="field">Frames
            <input className="input" type="number" min={1} max={16} value={frames} style={{ width: 70 }} onChange={e => setFrames(Math.max(1, Math.min(16, +e.target.value || 1)))} />
          </label>
          <div className="field">Policy
            <div className="policy-tabs">{POLICIES.map(p => <button key={p} className={`chip ${p === policy ? 'on' : ''}`} onClick={() => setPolicy(p)}><i style={{ background: PCOLOR[p] }} />{p.toUpperCase()}</button>)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {PRESETS.map(([k, v]) => <button key={k} className="chip" onClick={() => setText(v)}>{k}</button>)}
        </div>
        {!valid && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 8 }}>Enter 1–64 non-negative page numbers separated by spaces or commas.</div>}
      </div>
      {res && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <h4>{policy.toUpperCase()} with {frames} frame{frames > 1 ? 's' : ''}: <span style={{ color: '#f472b6' }}>{res.faults} faults</span> · {refs!.length - res.faults} hits · hit ratio {(((refs!.length - res.faults) / refs!.length) * 100).toFixed(0)}%</h4>
          <table className="refgrid">
            <thead><tr><th />{refs!.map((r, i) => <th key={i}>{r}</th>)}</tr></thead>
            <tbody>
              {Array.from({ length: frames }, (_, f) => (
                <tr key={f}><th className="faint">f{f}</th>
                  {res.steps.map((s, i) => {
                    const v = s.frames[f];
                    const isNew = s.fault && v === s.ref;
                    const isHit = !s.fault && v === s.ref;
                    return <td key={i} className={isNew ? 'new' : isHit ? 'hitc' : ''}>{v ?? ''}</td>;
                  })}
                </tr>
              ))}
              <tr className="fault-row"><td />{res.steps.map((s, i) => <td key={i} className={s.fault ? 'f' : ''} title={s.victim !== null ? `evicted ${s.victim}` : ''}>{s.fault ? (s.victim !== null ? `✕${s.victim}` : '•') : ''}</td>)}</tr>
            </tbody>
          </table>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>Pink: page loaded by a fault. Teal: hit. ✕n: page n evicted.</div>
        </div>
      )}
      {valid && (
        <div className="card">
          <h4>Faults vs. frames {anomaly && <span className="sev warning">Belady's anomaly: FIFO gets worse with more frames</span>}</h4>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 640, display: 'block' }} role="img" aria-label="Fault curve">
            {Array.from({ length: maxF }, (_, i) => <g key={i}><line x1={px(i + 1)} x2={px(i + 1)} y1={10} y2={H - PAD} stroke="#1c2531" /><text x={px(i + 1)} y={H - 10} textAnchor="middle" fill="#66758a" fontSize="10">{i + 1}</text></g>)}
            {[0, 0.5, 1].map(f => <text key={f} x={4} y={py(maxY * f) + 3} fill="#66758a" fontSize="10">{Math.round(maxY * f)}</text>)}
            {curves.map(({ p, c }) => (
              <g key={p}>
                <polyline fill="none" stroke={PCOLOR[p]} strokeWidth={p === policy ? 2.6 : 1.4} opacity={p === policy ? 1 : 0.55} points={c.map((v, i) => `${px(i + 1)},${py(v)}`).join(' ')} />
                {c.map((v, i) => <circle key={i} cx={px(i + 1)} cy={py(v)} r={p === policy ? 3.2 : 2} fill={PCOLOR[p]} opacity={p === policy ? 1 : 0.6}><title>{`${p.toUpperCase()} · ${i + 1} frames: ${v} faults`}</title></circle>)}
              </g>
            ))}
          </svg>
          <div style={{ display: 'flex', gap: 12, fontSize: 11.5, marginTop: 4 }}>{POLICIES.map(p => <span key={p} style={{ color: PCOLOR[p] }}>● {p.toUpperCase()}</span>)}<span className="faint">x: frames · y: faults</span></div>
        </div>
      )}
    </div>
  );
}
