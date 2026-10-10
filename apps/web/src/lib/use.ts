import { useSyncExternalStore } from 'react';
import { ctl } from './controller';

/** Re-render on every controller change. Components read `ctl` directly. */
export function useCtl() {
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  return ctl;
}
