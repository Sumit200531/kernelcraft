const P = (d: string) => () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
export const IPlay = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>;
export const IPause = () => <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.2" /><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" /></svg>;
export const IStepF = P('M5 5l8 7-8 7M17 5v14');
export const IStepB = P('M19 5l-8 7 8 7M7 5v14');
export const IStart = P('M18 5l-8 7 8 7M6 5v14');
export const IEnd = P('M6 5l8 7-8 7M18 5v14');
export const IRun = P('M5 3l14 9-14 9V3z');
export const ISave = P('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8');
export const IFolder = P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z');
export const IKey = P('M4 6h16M4 12h16M4 18h10');
export const IHelp = P('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z');
export const ISend = P('M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z');
export const IX = P('M18 6L6 18M6 6l12 12');
export const ISpark = P('M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8');
export const ICheck = P('M20 6L9 17l-5-5');
export const IZoomIn = P('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M11 8v6M8 11h6');
export const IZoomOut = P('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M8 11h6');
export const Logo = () => (
  <svg className="logo" viewBox="0 0 32 32">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5eead4" /><stop offset="1" stopColor="#a78bfa" /></linearGradient></defs>
    <rect x="3" y="3" width="26" height="26" rx="7" fill="none" stroke="url(#lg)" strokeWidth="2" />
    <rect x="9" y="9" width="14" height="14" rx="2.5" fill="url(#lg)" opacity=".9" />
    <path d="M13 3v4M19 3v4M13 25v4M19 25v4M3 13h4M3 19h4M25 13h4M25 19h4" stroke="url(#lg)" strokeWidth="2" strokeLinecap="round" />
    <path d="M13.5 13.5l5 2.5-5 2.5z" fill="#07090d" />
  </svg>
);
