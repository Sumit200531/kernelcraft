/**
 * Page-replacement lab: replay a page reference string against a fixed number of
 * frames. Independent of the kernel so it can (a) power the "reference string"
 * view and (b) serve as an oracle that the kernel's paging is checked against.
 *
 * Policies match the kernel exactly: free frames are filled lowest-index first;
 * FIFO evicts the oldest load, LRU the least recent use (ties → lowest frame),
 * Clock is second-chance with a hand that only advances during replacement, and
 * OPT (Belady's optimal, not available inside the kernel) evicts the page whose
 * next use is furthest in the future.
 */
export type RefPolicy = 'fifo' | 'lru' | 'clock' | 'opt';

export interface RefStep { ref: number; fault: boolean; frames: (number | null)[]; victim: number | null; hand?: number }
export interface RefResult { policy: RefPolicy; frames: number; faults: number; hits: number; steps: RefStep[] }

export function simulateRefString(refs: number[], frameCount: number, policy: RefPolicy): RefResult {
  const frames: (number | null)[] = Array(frameCount).fill(null);
  const loadedAt: number[] = Array(frameCount).fill(-1);
  const lastUse: number[] = Array(frameCount).fill(-1);
  const refBit: boolean[] = Array(frameCount).fill(false);
  let hand = 0, faults = 0;
  const steps: RefStep[] = [];
  refs.forEach((page, t) => {
    const at = frames.indexOf(page);
    if (at >= 0) {
      lastUse[at] = t; refBit[at] = true;
      steps.push({ ref: page, fault: false, frames: [...frames], victim: null, hand: policy === 'clock' ? hand : undefined });
      return;
    }
    faults++;
    let idx = frames.indexOf(null);
    let victim: number | null = null;
    if (idx < 0) {
      if (policy === 'fifo') idx = argmin(loadedAt);
      else if (policy === 'lru') idx = argmin(lastUse);
      else if (policy === 'clock') {
        for (;;) {
          const i = hand; hand = (hand + 1) % frameCount;
          if (refBit[i]) { refBit[i] = false; continue; }
          idx = i; break;
        }
      } else {
        let best = 0, bestNext = -1;
        for (let i = 0; i < frameCount; i++) {
          let next = refs.indexOf(frames[i]!, t + 1);
          if (next < 0) next = Infinity;
          if (next > bestNext) { bestNext = next; best = i; }
        }
        idx = best;
      }
      victim = frames[idx];
    }
    frames[idx] = page; loadedAt[idx] = t; lastUse[idx] = t; refBit[idx] = true;
    steps.push({ ref: page, fault: true, frames: [...frames], victim, hand: policy === 'clock' ? hand : undefined });
  });
  return { policy, frames: frameCount, faults, hits: refs.length - faults, steps };
}

function argmin(xs: number[]): number { let b = 0; for (let i = 1; i < xs.length; i++) if (xs[i] < xs[b]) b = i; return b; }

/** Faults for 1..maxFrames frames, for spotting Belady's anomaly (FIFO faults rising with more frames). */
export function faultCurve(refs: number[], maxFrames: number, policy: RefPolicy): number[] {
  return Array.from({ length: maxFrames }, (_, i) => simulateRefString(refs, i + 1, policy).faults);
}

export function parseRefString(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.length > 500) return null;
  const nums = parts.map(p => Number(p));
  return nums.every(n => Number.isInteger(n) && n >= 0 && n < 1000) ? nums : null;
}
