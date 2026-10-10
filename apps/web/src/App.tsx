import { useEffect, useState } from 'react';
import { useCtl } from './lib/use';
import type { CenterTab } from './lib/controller';
import { TopBar } from './components/TopBar';
import { Editor } from './components/Editor';
import { Timeline } from './components/Timeline';
import { MemoryView } from './components/MemoryView';
import { SyncView } from './components/SyncView';
import { MetricsView } from './components/MetricsView';
import { RefLab } from './components/RefLab';
import { SidePanel } from './components/SidePanel';
import { Bottom } from './components/Bottom';
import { IX } from './components/Icons';

const TABS: [CenterTab, string][] = [['timeline', 'Timeline'], ['memory', 'Memory'], ['sync', 'Sync'], ['metrics', 'Metrics'], ['lab', 'Ref-string lab']];

function Center() {
  const c = useCtl();
  const m = c.machine;
  const faults = c.fullEvents.filter(e => e.type === 'PAGE_FAULT' && e.t < c.cursor).length;
  const syncBad = m?.s.deadlock || m?.s.status === 'stalled';
  return (
    <section className="panel area-center" aria-label="Visualisation">
      <div className="panel-head" style={{ padding: '0 4px' }}>
        <div className="tabs" role="tablist">
          {TABS.map(([k, label], i) => (
            <button key={k} role="tab" aria-selected={c.tab === k} className={`tab ${c.tab === k ? 'on' : ''}`} onClick={() => c.setTab(k)} title={`${label} (${i + 1})`}>
              {label}
              {k === 'memory' && faults > 0 && <span className="count">{faults}</span>}
              {k === 'sync' && syncBad && <span className="count bad">!</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {m && <span className="faint mono hide-sm view-meta" style={{ fontSize: 11, paddingRight: 8 }}>{m.s.config.cores} core{m.s.config.cores > 1 ? 's' : ''} · {m.s.config.scheduler}{m.s.config.scheduler === 'rr' ? ` q=${m.s.config.quantum}` : ''}{m.s.config.cs ? ` · cs=${m.s.config.cs}` : ''} · trace {c.hash}</span>}
      </div>
      <div className="panel-body">
        {c.tab === 'timeline' ? <Timeline /> : c.tab === 'memory' ? <MemoryView /> : c.tab === 'sync' ? <SyncView /> : c.tab === 'metrics' ? <MetricsView /> : <RefLab />}
      </div>
    </section>
  );
}

const SHORTCUTS: [string[], string][] = [
  [['Space'], 'play / pause'], [['←', '→'], 'step one tick'], [['Shift', '← →'], 'step ten ticks'], [['Home', 'End'], 'start / end of run'],
  [['Ctrl', 'Enter'], 'run the workload'], [['1–5'], 'switch view'], [['`'], 'focus the terminal'], [['/'], 'ask the assistant'], [['?'], 'this help'], [['Esc'], 'close dialogs']
];

function Help() {
  const c = useCtl();
  if (!c.showHelp) return null;
  return (
    <div className="overlay" onClick={() => c.setHelp(false)}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-head"><h2>Keyboard shortcuts</h2><span className="spacer" /><button className="btn ghost icon" aria-label="Close" onClick={() => c.setHelp(false)}><IX /></button></div>
        <div className="modal-body">
          <div className="shortcuts">{SHORTCUTS.map(([keys, what]) => [<div key={what + 'k'}>{keys.map(k => <kbd key={k}>{k}</kbd>)}</div>, <div key={what}>{what}</div>])}</div>
          <p className="dim" style={{ fontSize: 12.5, marginTop: 16 }}>
            Every run is deterministic: the same workload and the same operator actions always produce the same trace (its hash is shown in the view header).
            Scrubbing re-executes from the nearest keyframe, so every state you see was actually computed. Operator actions (kill, signal, unlock) made in the past start a new branch.
          </p>
        </div>
      </div>
    </div>
  );
}

function Recordings() {
  const c = useCtl();
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!c.showRecordings) return null;
  const save = async () => {
    const t = (title.trim() || (c.sampleId ? `${c.sampleId} run` : 'My experiment')).slice(0, 120);
    setBusy(true); const r = await c.saveRecording(t); setBusy(false); setTitle(''); c.toast(r);
  };
  return (
    <div className="overlay" onClick={() => c.setRecordings(false)}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Recordings">
        <div className="modal-head">
          <h2>Recordings</h2>
          <span className="faint" style={{ fontSize: 12 }}>{c.recordingsSource === 'api' ? `stored in ${c.health?.storage}` : 'stored in this browser (no API connected)'}</span>
          <span className="spacer" /><button className="btn ghost icon" aria-label="Close" onClick={() => c.setRecordings(false)}><IX /></button>
        </div>
        <div className="modal-body">
          <form className="save-row" onSubmit={e => { e.preventDefault(); void save(); }}>
            <input id="rec-title" className="input" autoFocus={c.saveIntent} value={title} maxLength={120} onChange={e => setTitle(e.target.value)}
              placeholder={c.sampleId ? `${c.sampleId} run` : 'Title for this run'} aria-label="Recording title" />
            <button className="btn primary" disabled={busy}>Save current run</button>
          </form>
          <div className="faint" style={{ fontSize: 11.5, margin: '6px 0 12px' }}>Saves the workload and every operator action (kill, signal, unlock) with its trace fingerprint {c.hash}{c.inputs.length ? ` · ${c.inputs.length} recorded action(s)` : ''}.</div>
          {c.recordings.length === 0 && <div className="empty">No recordings yet.</div>}
          {c.recordings.map(r => (
            <div key={r.id} className="rec">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{r.title}</div>
                <div className="faint mono" style={{ fontSize: 11 }}>{r.status} · {r.ticks} ticks · trace {r.traceHash} · {new Date(r.createdAt).toLocaleString()}</div>
                {msg[r.id] && <div style={{ fontSize: 11.5, color: msg[r.id].startsWith('reproducible') ? 'var(--good)' : 'var(--warn)' }}>{msg[r.id]}</div>}
              </div>
              <button className="btn sm" onClick={async () => setMsg({ ...msg, [r.id]: await c.verifyRecording(r.id).catch(e => `error: ${e.message}`) })}>Verify</button>
              <button className="btn sm" onClick={async () => { const e = await c.openRecording(r.id).catch(err => err.message); if (e) setMsg({ ...msg, [r.id]: e }); }}>Replay</button>
              {armed === r.id
                ? <button className="btn sm" style={{ color: 'var(--bad)', borderColor: 'rgba(248,113,113,.5)' }} onClick={() => { setArmed(null); void c.deleteRecording(r.id); }}>Delete</button>
                : <button className="btn sm ghost" aria-label={`Delete ${r.title}`} title="Delete" onClick={() => setArmed(r.id)}><IX /></button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const c = useCtl();
  useEffect(() => {
    c.run({ cursor: 0 });
    void c.checkHealth();
    const t = setTimeout(() => c.autoplay(), 450);
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable;
      if (e.key === 'Escape') { c.setHelp(false); if (c.showRecordings) c.setRecordings(false); if (typing && el.tagName !== 'TEXTAREA') el.blur(); return; }
      if (typing) return;
      if (e.ctrlKey || e.metaKey) { if (e.key === 'Enter') { e.preventDefault(); c.run({ inputs: c.dirty ? [] : c.inputs, cursor: 'end' }); } return; }
      switch (e.key) {
        case ' ': e.preventDefault(); c.toggle(); break;
        case 'ArrowRight': e.preventDefault(); c.pause(); c.step(e.shiftKey ? 10 : 1); break;
        case 'ArrowLeft': e.preventDefault(); c.pause(); c.step(e.shiftKey ? -10 : -1); break;
        case 'Home': c.pause(); c.seek(0); break;
        case 'End': c.pause(); c.seek(c.horizon); break;
        case '?': c.setHelp(!c.showHelp); break;
        case '`': e.preventDefault(); window.dispatchEvent(new Event('kc:focus-terminal')); break;
        case '/': e.preventDefault(); c.focusChat(); break;
        default: if (/^[1-5]$/.test(e.key)) c.setTab(TABS[+e.key - 1][0]);
      }
    };
    const onHash = () => { const id = /sample=([\w-]+)/.exec(location.hash)?.[1]; if (id && id !== c.sampleId) c.loadSample(id); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); c.pause(); };
  }, [c]);
  return (
    <div className="app">
      <TopBar />
      <main className="workspace">
        <Editor />
        <Center />
        <Bottom />
        <SidePanel />
      </main>
      <Help />
      <Recordings />
      {c.flash && <div className="toast" role="status">{c.flash}</div>}
    </div>
  );
}
