import { SAMPLES } from '@kernelcraft/engine';
import { useCtl } from '../lib/use';
import { IPlay, IPause, IStepF, IStepB, IStart, IEnd, IRun, ISave, IFolder, IHelp, Logo } from './Icons';

export function TopBar() {
  const c = useCtl();
  const status = c.full ? (c.cursor < c.horizon ? 'running' : c.full.s.status) : 'ready';
  const pct = c.horizon ? (c.cursor / c.horizon) * 100 : 0;
  const topics = [...new Set(SAMPLES.map(s => s.topic))];
  const hasErr = c.diagnostics.some(d => d.severity === 'error');
  return (
    <header className="topbar">
      <div className="brand"><Logo /> KernelCraft <small className="hide-sm">OS lab</small></div>
      <div className="sep hide-sm" />
      <select className="select" aria-label="Sample workload" value={c.sampleId ?? ''} onChange={e => e.target.value && c.loadSample(e.target.value)}>
        <option value="">{c.sampleId ? '' : 'Custom workload'}</option>
        {topics.map(t => (
          <optgroup key={t} label={t}>{SAMPLES.filter(s => s.topic === t).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</optgroup>
        ))}
      </select>
      <button className={`btn primary${c.dirty ? ' dirty' : ''}`} disabled={hasErr} onClick={() => c.run({ inputs: c.dirty ? [] : c.inputs, cursor: 'end' })}
        title={hasErr ? 'Fix the errors in the workload first' : 'Run the workload (Ctrl+Enter)'}>
        <IRun /> Run{c.dirty ? ' *' : ''}
      </button>
      <div className="sep" />
      <div className="transport">
        <button className="btn ghost icon" aria-label="Go to start" title="Start (Home)" onClick={() => c.seek(0)} disabled={!c.session}><IStart /></button>
        <button className="btn ghost icon" aria-label="Step back" title="Step back (←, Shift for 10)" onClick={() => c.step(-1)} disabled={!c.session || c.cursor === 0}><IStepB /></button>
        <button className="btn primary play-btn" aria-label={c.playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={() => c.toggle()} disabled={!c.session}>{c.playing ? <IPause /> : <IPlay />}</button>
        <button className="btn ghost icon" aria-label="Step forward" title="Step (→, Shift for 10)" onClick={() => c.step(1)} disabled={!c.session || c.cursor >= c.horizon}><IStepF /></button>
        <button className="btn ghost icon" aria-label="Go to end" title="End (End)" onClick={() => c.seek(c.horizon)} disabled={!c.session}><IEnd /></button>
      </div>
      <div className="scrub">
        <input type="range" aria-label="Time" min={0} max={Math.max(1, c.horizon)} value={c.cursor} style={{ ['--pct' as string]: `${pct}%` }}
          onChange={e => { c.pause(); c.seek(+e.target.value); }} disabled={!c.session} />
        <div className="tick-readout">t={c.cursor}<span> / {c.horizon}</span></div>
      </div>
      <select className="select hide-sm" style={{ width: 92 }} aria-label="Playback speed" value={c.speed} onChange={e => c.setSpeed(+e.target.value)} title="Ticks per second">
        {[2, 4, 8, 12, 24, 48, 96, 240].map(v => <option key={v} value={v}>{v} t/s</option>)}
      </select>
      <span className={`status-pill ${status}`} title={c.full ? `final status: ${c.full.s.status}` : ''}><span className="dot" />{status === 'running' ? 'replaying' : status}</span>
      <div className="sep hide-sm" />
      <button className="btn ghost icon" aria-label="Recordings" title="Recordings" onClick={() => c.setRecordings(true)}><IFolder /></button>
      <button className="btn ghost icon" aria-label="Save recording" title="Save this run as a recording" onClick={() => c.setRecordings(true, true)}><ISave /></button>
      <button className="btn ghost icon" aria-label="Keyboard shortcuts" title="Shortcuts (?)" onClick={() => c.setHelp(true)}><IHelp /></button>
      <span className={`api-badge hide-sm${c.health ? ' on' : ''}`} title={c.health ? `API ${c.health.engine} · storage ${c.health.storage} · ${c.health.narration} assistant` : 'No API reachable: everything runs in the browser, recordings are stored locally'}>
        <span className="dot" />{c.health ? (c.health.storage === 'postgres' ? 'API · Postgres' : 'API') : 'Local'}
      </span>
    </header>
  );
}
