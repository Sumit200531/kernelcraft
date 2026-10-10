import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SimEvent } from '@kernelcraft/engine';
import { useCtl } from '../lib/use';
import { threadColor, BLOCK_COLOR } from '../lib/colors';
import { IZoomIn, IZoomOut } from './Icons';

const LABEL_W = 150;
const AXIS_H = 24;
const BASE_CORE_H = 24;
const BASE_THREAD_H = 20;
const BASE_MEM_H = 34;
const GAP = 10;

const MARK: Record<string, { color: string; shape: 'tri' | 'dot' | 'x' | 'dia' | 'bar' }> = {
  PAGE_FAULT: { color: '#f472b6', shape: 'tri' },
  LOCK_CONTEND: { color: '#f87171', shape: 'dot' },
  SEM_BLOCK: { color: '#fb923c', shape: 'dot' },
  PREEMPT: { color: '#e2e8f0', shape: 'bar' },
  LOST_UPDATE: { color: '#c084fc', shape: 'x' },
  RACE: { color: '#c084fc', shape: 'dia' },
  SEGFAULT: { color: '#f87171', shape: 'x' },
  INJECT: { color: '#60a5fa', shape: 'dia' },
  PRIORITY_INHERIT: { color: '#fbbf24', shape: 'dia' },
  STARVATION: { color: '#fbbf24', shape: 'x' }
};

interface Hover { x: number; y: number; tick: number; row: string; tid?: number; core?: number; ev?: SimEvent }

export function Timeline() {
  const c = useCtl();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 300 });
  const [ppt, setPpt] = useState<number | null>(null);   // pixels per tick; null = fit
  const [sx, setSx] = useState(0);
  const [sy, setSy] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const drag = useRef<{ x: number; sx: number; moved: boolean } | null>(null);

  const ticks = c.fullTicks;
  const N = Math.max(1, ticks.length);
  const m = c.full;
  const threads = m?.s.threads ?? [];
  const cores = m?.s.config.cores ?? 1;
  const plotW = Math.max(50, size.w - LABEL_W - 12);
  const fit = plotW / (N + Math.max(1.5, N * 0.03));   // leave room for end-of-run markers
  const scale = ppt ?? fit;
  const contentW = N * scale;
  const maxSx = Math.max(0, contentW + 40 - plotW);
  const rowsTop = AXIS_H + 6;
  // grow rows to fill the panel when there are few threads
  const baseH = cores * (BASE_CORE_H + 3) + threads.length * (BASE_THREAD_H + 2) + BASE_MEM_H;
  const k = Math.max(1, Math.min(1.7, (size.h - rowsTop - 2 * GAP - 10) / Math.max(1, baseH)));
  const CORE_H = Math.round(BASE_CORE_H * k), THREAD_H = Math.round(BASE_THREAD_H * k), MEM_H = Math.round(BASE_MEM_H * k);
  const threadTop = rowsTop + cores * (CORE_H + 3) + GAP;
  const memTop = threadTop + threads.length * (THREAD_H + 2) + GAP;
  const contentH = memTop + MEM_H + 8;
  const maxSy = Math.max(0, contentH - size.h);

  useLayoutEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [!!m]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPpt(null); setSx(0); }, [c.hash]);
  // follow the cursor while playing / stepping
  useEffect(() => {
    if (ppt === null) return;
    const x = c.cursor * scale;
    if (x < sx + 20 || x > sx + plotW - 40) setSx(Math.max(0, Math.min(maxSx, x - plotW * 0.6)));
  }, [c.cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------- draw */
  useEffect(() => {
    const canvas = cv.current; if (!canvas || !m) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr); canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = size.w + 'px'; canvas.style.height = size.h + 'px';
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const ox = LABEL_W - sx;                   // x of tick 0
    const X = (t: number) => ox + t * scale;
    const t0 = Math.max(0, Math.floor(sx / scale) - 1), t1 = Math.min(N, Math.ceil((sx + plotW) / scale) + 1);
    const cur = c.cursor;

    g.save();
    g.beginPath(); g.rect(LABEL_W, 0, plotW + 12, size.h); g.clip();
    g.translate(0, -sy);

    // grid + axis
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(s => s * scale >= 46) ?? 10000;
    g.font = '10px JetBrains Mono, monospace'; g.textBaseline = 'middle';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = X(t);
      g.fillStyle = 'rgba(255,255,255,.035)'; g.fillRect(Math.round(x), rowsTop, 1, contentH - rowsTop);
      g.fillStyle = '#56657a'; g.fillText(String(t), x + 3, sy + AXIS_H / 2 + 2);
    }

    // future region (recorded but not yet replayed)
    const dimAfter = (fn: () => void, from: number, to: number) => {
      if (from < cur) { g.save(); g.beginPath(); g.rect(X(from), 0, X(Math.min(to, cur)) - X(from), contentH + sy); g.clip(); fn(); g.restore(); }
      if (to > cur) { g.save(); g.globalAlpha = 0.28; g.beginPath(); g.rect(X(Math.max(from, cur)), 0, X(to) - X(Math.max(from, cur)), contentH + sy); g.clip(); fn(); g.restore(); }
    };

    dimAfter(() => {
      // cores
      for (let k = 0; k < cores; k++) {
        const y = rowsTop + k * (CORE_H + 3);
        let s = t0;
        while (s < t1) {
          const r = ticks[s]?.cores[k];
          let e = s + 1;
          while (e < t1 && ticks[e]?.cores[k].kind === r?.kind && ticks[e]?.cores[k].tid === r?.tid) e++;
          if (r && r.kind !== 'idle') {
            const x = X(s), w = Math.max(1, (e - s) * scale - (scale > 3 ? 1 : 0));
            if (r.kind === 'run') {
              const col = threadColor(r.tid);
              const grad = g.createLinearGradient(0, y, 0, y + CORE_H);
              grad.addColorStop(0, col); grad.addColorStop(1, col + 'bb');
              g.fillStyle = grad; g.beginPath(); g.roundRect(x, y, w, CORE_H, Math.min(4, w / 2)); g.fill();
              if (w > 38) { g.fillStyle = '#06110f'; g.font = '600 10.5px Inter, sans-serif'; g.fillText(threads[r.tid].name.replace('.main', ''), x + 5, y + CORE_H / 2 + 1, w - 8); }
            } else {
              g.fillStyle = '#2a3443'; g.fillRect(x, y, w, CORE_H);
              g.strokeStyle = '#4b5a6e'; g.lineWidth = 1;
              for (let hx = x - CORE_H; hx < x + w; hx += 5) { g.beginPath(); g.moveTo(Math.max(x, hx), y + CORE_H - Math.max(0, x - hx)); g.lineTo(Math.min(x + w, hx + CORE_H), y + Math.max(0, hx + CORE_H - x - w)); g.stroke(); }
            }
          }
          s = e;
        }
      }
      // threads
      threads.forEach((th, i) => {
        const y = threadTop + i * (THREAD_H + 2);
        if (c.selectedTid === th.tid) { g.fillStyle = 'rgba(94,234,212,.05)'; g.fillRect(X(t0), y - 1, (t1 - t0) * scale, THREAD_H + 2); }
        let s = t0;
        while (s < t1) {
          const st = ticks[s]?.states[i], bk = ticks[s]?.blockKinds[i];
          let e = s + 1;
          while (e < t1 && ticks[e]?.states[i] === st && ticks[e]?.blockKinds[i] === bk) e++;
          const x = X(s), w = Math.max(1, (e - s) * scale - (scale > 3 ? 1 : 0));
          const col = threadColor(th.tid);
          if (st === 'running') { g.fillStyle = col; g.beginPath(); g.roundRect(x, y + 2, w, THREAD_H - 4, Math.min(3, w / 2)); g.fill(); }
          else if (st === 'ready') { g.fillStyle = col + '2e'; g.fillRect(x, y + 5, w, THREAD_H - 10); g.fillStyle = col + '70'; g.fillRect(x, y + THREAD_H / 2 - .5, w, 1); }
          else if (st === 'blocked') {
            const bc = BLOCK_COLOR[bk ?? ''] ?? '#f59e0b';
            g.fillStyle = bc + '40'; g.fillRect(x, y + 4, w, THREAD_H - 8);
            g.fillStyle = bc; g.fillRect(x, y + 4, w, 2); g.fillRect(x, y + THREAD_H - 6, w, 2);
            if (w > 30) { g.fillStyle = bc; g.font = '9.5px JetBrains Mono, monospace'; g.fillText(bk ?? '', x + 4, y + THREAD_H / 2, w - 6); }
          }
          s = e;
        }
      });
      // memory pressure
      const frames = m.s.config.frames;
      g.beginPath(); g.moveTo(X(t0), memTop + MEM_H);
      for (let t = t0; t < t1; t++) { const v = (ticks[t]?.framesUsed ?? 0) / frames; g.lineTo(X(t), memTop + MEM_H - v * MEM_H); g.lineTo(X(t + 1), memTop + MEM_H - v * MEM_H); }
      g.lineTo(X(t1), memTop + MEM_H); g.closePath();
      const mg = g.createLinearGradient(0, memTop, 0, memTop + MEM_H); mg.addColorStop(0, 'rgba(244,114,182,.55)'); mg.addColorStop(1, 'rgba(244,114,182,.05)');
      g.fillStyle = mg; g.fill();
    }, t0, t1);

    // event markers (all, dimmed in the future)
    const rowY = (tid: number) => threadTop + tid * (THREAD_H + 2);
    for (const e of c.fullEvents) {
      if (e.t < t0 - 1 || e.t > t1) continue;
      if (e.type === 'DEADLOCK' || e.type === 'STALL') {
        g.fillStyle = e.t <= cur ? 'rgba(248,113,113,.14)' : 'rgba(248,113,113,.06)';
        g.fillRect(X(e.t), rowsTop, Math.max(8, X(N) - X(e.t) + 40), contentH - rowsTop);
        g.fillStyle = '#f87171'; g.fillRect(X(e.t), rowsTop, 2, contentH - rowsTop);
        g.font = '700 10px JetBrains Mono, monospace'; g.fillText(e.type, X(e.t) + 6, rowsTop + 8);
        continue;
      }
      const mk = MARK[e.type]; if (!mk || e.tid === undefined) continue;
      const x = X(e.t) + scale / 2, y = rowY(e.tid);
      g.globalAlpha = e.t < cur ? 1 : 0.3;
      g.fillStyle = mk.color; g.strokeStyle = mk.color; g.lineWidth = 1.5;
      if (mk.shape === 'tri') { g.beginPath(); g.moveTo(x - 4, y - 1); g.lineTo(x + 4, y - 1); g.lineTo(x, y + 5); g.fill(); }
      else if (mk.shape === 'dot') { g.beginPath(); g.arc(x, y + 2, 3, 0, Math.PI * 2); g.fill(); }
      else if (mk.shape === 'x') { g.beginPath(); g.moveTo(x - 3, y - 1); g.lineTo(x + 3, y + 5); g.moveTo(x + 3, y - 1); g.lineTo(x - 3, y + 5); g.stroke(); }
      else if (mk.shape === 'dia') { g.beginPath(); g.moveTo(x, y - 2); g.lineTo(x + 4, y + 2); g.lineTo(x, y + 6); g.lineTo(x - 4, y + 2); g.fill(); }
      else { g.fillRect(X(e.t + 1) - 1, y + 1, 2, THREAD_H - 2); }
      if (c.selectedEvent === e.id) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y + 2, 7, 0, Math.PI * 2); g.stroke(); }
      g.globalAlpha = 1;
    }

    // cursor
    const cx = X(cur);
    g.fillStyle = 'rgba(94,234,212,.12)'; g.fillRect(cx - 3, rowsTop, 6, contentH - rowsTop);
    g.fillStyle = '#5eead4'; g.shadowColor = '#5eead4'; g.shadowBlur = 10; g.fillRect(cx - 1, rowsTop - 2, 2, contentH - rowsTop + 2); g.shadowBlur = 0;
    g.restore();

    // axis band + cursor handle (not scrolled vertically)
    g.save(); g.beginPath(); g.rect(LABEL_W, 0, plotW + 12, AXIS_H + 4); g.clip();
    g.fillStyle = '#5eead4'; g.beginPath(); g.moveTo(cx - 6, 2); g.lineTo(cx + 6, 2); g.lineTo(cx + 6, 12); g.lineTo(cx, 18); g.lineTo(cx - 6, 12); g.fill();
    g.restore();

    // labels column
    g.save(); g.translate(0, -sy);
    g.fillStyle = '#0b0f15'; g.fillRect(0, sy, LABEL_W, size.h);
    g.font = '600 10.5px Inter, sans-serif'; g.textBaseline = 'middle';
    for (let k = 0; k < cores; k++) { const y = rowsTop + k * (CORE_H + 3); g.fillStyle = '#9aa8b9'; g.fillText(`CPU ${k}`, 12, y + CORE_H / 2); }
    g.font = '11px Inter, sans-serif';
    threads.forEach((th, i) => {
      const y = threadTop + i * (THREAD_H + 2);
      g.fillStyle = threadColor(th.tid); g.beginPath(); g.roundRect(12, y + 6, 8, 8, 2); g.fill();
      g.fillStyle = c.selectedTid === th.tid ? '#ffffff' : '#c3cdd9';
      g.fillText(th.name.replace('.main', ''), 26, y + THREAD_H / 2, LABEL_W - 34);
    });
    g.fillStyle = '#9aa8b9'; g.font = '600 10.5px Inter, sans-serif'; g.fillText('Frames used', 12, memTop + MEM_H / 2);
    g.restore();
    g.fillStyle = '#1c2531'; g.fillRect(LABEL_W - 1, 0, 1, size.h);
  }, [c.version, size, scale, sx, sy, m, ticks, N, plotW, threads, cores, threadTop, memTop, contentH, rowsTop]);

  /* ------------------------------------------------------------- input */
  const locate = (clientX: number, clientY: number): Hover | null => {
    const r = cv.current!.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top + sy;
    if (x < LABEL_W) return null;
    const tick = Math.floor((x - LABEL_W + sx) / scale);
    if (tick < 0 || tick >= N) return null;
    let row = 'axis', tid: number | undefined, core: number | undefined, ev: SimEvent | undefined;
    if (y >= rowsTop && y < threadTop - GAP) { core = Math.floor((y - rowsTop) / (CORE_H + 3)); row = 'core'; }
    else if (y >= threadTop && y < memTop - GAP) {
      tid = Math.floor((y - threadTop) / (THREAD_H + 2)); row = 'thread';
      ev = c.fullEvents.find(e => e.tid === tid && e.t === tick && MARK[e.type]);
    } else if (y >= memTop) row = 'mem';
    return { x: clientX - r.left, y: clientY - r.top, tick, row, tid, core, ev };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const r = cv.current!.getBoundingClientRect();
      const mx = e.clientX - r.left - LABEL_W;
      const tAt = (mx + sx) / scale;
      const ns = Math.max(Math.min(fit, 1), Math.min(48, scale * (e.deltaY < 0 ? 1.25 : 0.8)));
      setPpt(ns);
      setSx(Math.max(0, Math.min(N * ns - plotW, tAt * ns - mx)));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || maxSy === 0) {
      setSx(v => Math.max(0, Math.min(maxSx, v + (e.deltaX || e.deltaY))));
    } else setSy(v => Math.max(0, Math.min(maxSy, v + e.deltaY)));
  };

  const zoom = (f: number) => {
    const ns = Math.max(Math.min(fit, 1), Math.min(48, scale * f));
    const center = (sx + plotW / 2) / scale;
    setPpt(ns); setSx(Math.max(0, Math.min(N * ns - plotW, center * ns - plotW / 2)));
  };

  if (!m) return <div className="empty">Run a workload to see its timeline.</div>;

  const ht = hover ? ticks[hover.tick] : null;
  const evsAt = hover && hover.tid !== undefined ? c.fullEvents.filter(e => e.t === hover.tick && e.tid === hover.tid && e.type !== 'MEM_ACCESS' && e.type !== 'TLB_HIT').slice(0, 4) : [];
  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="legend">
          <span><i style={{ background: '#5eead4' }} />running</span>
          <span><i style={{ background: '#5eead42e', boxShadow: 'inset 0 0 0 1px #5eead470' }} />ready</span>
          {Object.entries(BLOCK_COLOR).map(([k, v]) => <span key={k}><i style={{ background: v + '55', boxShadow: `inset 0 2px 0 ${v}` }} />{k}</span>)}
          <span><i style={{ background: 'repeating-linear-gradient(45deg,#2a3443 0 2px,#4b5a6e 2px 3px)' }} />switch</span>
          <span style={{ color: '#f472b6' }}>▼ fault</span><span style={{ color: '#f87171' }}>● contend</span><span style={{ color: '#c084fc' }}>✕ lost update</span>
        </div>
        <span className="spacer" />
        <span className="faint hide-sm">Ctrl+wheel zoom · drag to pan · click to seek</span>
        <button className="btn sm icon" aria-label="Zoom out" onClick={() => zoom(0.66)}><IZoomOut /></button>
        <button className="btn sm icon" aria-label="Zoom in" onClick={() => zoom(1.5)}><IZoomIn /></button>
        <button className="btn sm" onClick={() => { setPpt(null); setSx(0); }}>Fit</button>
      </div>
      <div className="tl-canvas-wrap" ref={wrap}
        onWheel={onWheel}
        onMouseDown={e => { drag.current = { x: e.clientX, sx, moved: false }; }}
        onMouseMove={e => {
          if (drag.current && e.buttons === 1) {
            const dx = e.clientX - drag.current.x;
            if (Math.abs(dx) > 3) drag.current.moved = true;
            if (drag.current.moved) { setSx(Math.max(0, Math.min(maxSx, drag.current.sx - dx))); if (ppt === null) setPpt(scale); }
          }
          setHover(locate(e.clientX, e.clientY));
        }}
        onMouseUp={e => {
          const d = drag.current; drag.current = null;
          if (d?.moved) return;
          const h = locate(e.clientX, e.clientY);
          if (!h) { const r = cv.current!.getBoundingClientRect(); const y = e.clientY - r.top + sy; if (y >= threadTop && y < memTop) c.selectThread(Math.floor((y - threadTop) / (THREAD_H + 2))); return; }
          c.pause();
          if (h.ev) c.selectEvent(h.ev.id);
          else { if (h.tid !== undefined) c.selectThread(h.tid); c.seek(h.tick + 1); }
        }}
        onMouseLeave={() => { setHover(null); drag.current = null; }}>
        <canvas ref={cv} role="img" aria-label="CPU and thread timeline" />
        {hover && ht && (
          <div className="tooltip" style={{ left: Math.min(hover.x + 14, size.w - 300), top: Math.min(hover.y + 14, size.h - 120) }}>
            <div className="tt-head">tick {hover.tick} · [{hover.tick}, {hover.tick + 1})</div>
            {hover.row === 'core' && hover.core !== undefined && (() => { const r = ht.cores[hover.core]; return <div>CPU {hover.core}: {r.kind === 'idle' ? 'idle' : r.kind === 'switch' ? `context switch → ${threads[r.tid].name}` : <><b style={{ color: threadColor(r.tid) }}>{threads[r.tid].name}</b>{r.line ? ` · line ${r.line}` : ''}</>}</div>; })()}
            {hover.row === 'thread' && hover.tid !== undefined && threads[hover.tid] && (
              <>
                <div><b style={{ color: threadColor(hover.tid) }}>{threads[hover.tid].name}</b> · {ht.states[hover.tid]}{ht.blockKinds[hover.tid] ? ` (${ht.blockKinds[hover.tid]})` : ''}</div>
                {evsAt.map(e => <div key={e.id} className="dim" style={{ fontSize: 11.5 }}><span className="mono faint">#{e.id}</span> {e.msg}</div>)}
              </>
            )}
            {hover.row === 'mem' && <div>{ht.framesUsed} / {m.s.config.frames} frames in use</div>}
          </div>
        )}
      </div>
    </div>
  );
}
