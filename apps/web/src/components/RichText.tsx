import { Fragment, type ReactNode } from 'react';
import { ctl } from '../lib/controller';

/** `[#12]` → clickable evidence chip that jumps to the event. */
export function EvRef({ id }: { id: number }) {
  const e = ctl.fullEvents[id];
  return (
    <button className="evref" title={e ? `t=${e.t} ${e.type}: ${e.msg}` : 'unknown event'} onClick={() => ctl.selectEvent(id)}>#{id}</button>
  );
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[#(\d+)\]|\*\*(.+?)\*\*|`([^`]+)`|_(.+?)_/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<EvRef key={k} id={+m[1]} />);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4]) out.push(<em key={k}>{inline(m[4], k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Tiny markdown subset used by the assistant: paragraphs, `- ` bullets, bold, italics, code, citations. */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (k: number) => { if (bullets.length) { blocks.push(<ul key={`u${k}`}>{bullets.map((b, i) => <li key={i}>{inline(b, `b${k}-${i}`)}</li>)}</ul>); bullets = []; } };
  text.split('\n').forEach((line, i) => {
    if (/^\s*[-•]\s+/.test(line)) { bullets.push(line.replace(/^\s*[-•]\s+/, '')); return; }
    flush(i);
    if (line.trim()) blocks.push(<p key={i}>{inline(line, `p${i}`)}</p>);
  });
  flush(-1);
  return <div className="rich"><Fragment>{blocks}</Fragment></div>;
}
