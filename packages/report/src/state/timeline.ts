import type { BisectEvent } from '../types.ts';
import { applyEvent, emptyState, type ViewState } from './model.ts';

export const REVEAL_MS = 1200;

/**
 * Piecewise-linear comparison playhead over the captured step frames: the
 * playhead crawls through the breaking step at half rate and then holds on the
 * diverging pair, which is the frame anyone watching actually needs to read.
 */
export const COMPARE = {
  stepMs: 900,
  placeOrderMs: 1200,
  /** The break itself, advanced at half rate. */
  breakMs: 1800,
  holdMs: 3800,
};
export const COMPARE_LOOP_MS =
  5 * COMPARE.stepMs + COMPARE.placeOrderMs + COMPARE.breakMs + COMPARE.holdMs;

export interface TimelineMark {
  /** ms since the first event. */
  at: number;
  ev: BisectEvent;
}

export interface Timeline {
  marks: TimelineMark[];
  /** Total scrubbable length, including the post-run comparison tail. */
  duration: number;
  culpritAt?: number;
  /** Virtual ms at which each round starts, drawn as ticks on the scrubber. */
  roundStarts: { round: number; at: number }[];
  startedAtIso?: string;
}

export function buildTimeline(events: BisectEvent[]): Timeline {
  const marks: TimelineMark[] = [];
  const roundStarts: { round: number; at: number }[] = [];
  let base = 0;
  let culpritAt: number | undefined;
  let startedAtIso: string | undefined;

  events.forEach((ev, i) => {
    const ms = Date.parse(ev.at);
    const t = Number.isFinite(ms) ? ms : 0;
    if (i === 0) {
      base = t;
      startedAtIso = ev.at;
    }
    const at = Math.max(0, t - base);
    marks.push({ at, ev });
    if (ev.type === 'round.started') roundStarts.push({ round: ev.round, at });
    if (ev.type === 'culprit.found') culpritAt = at;
  });

  const last = marks.length ? marks[marks.length - 1].at : 0;
  const tail = culpritAt !== undefined ? culpritAt + REVEAL_MS + COMPARE_LOOP_MS : last;
  return {
    marks,
    duration: Math.max(last, tail) + 400,
    culpritAt,
    roundStarts,
    startedAtIso,
  };
}

/** Rebuilds the whole view state from scratch at virtual time `t`. */
export function stateAt(tl: Timeline, t: number): ViewState {
  const s = emptyState();
  for (const m of tl.marks) {
    if (m.at > t) break;
    applyEvent(s, m.ev, m.at);
  }
  return s;
}

export type Phase = 'search' | 'reveal' | 'compare';

export interface Scene {
  phase: Phase;
  /** 0..1 through the culprit reveal. */
  reveal: number;
  /** Fractional flow-step position (0..7) for the synchronized comparison. */
  comparePos: number;
  /** True while the comparison is in its 0.5x slow-motion window. */
  slowmo: boolean;
  compareLoopT: number;
}

export function sceneAt(tl: Timeline, t: number): Scene {
  const c = tl.culpritAt;
  if (c === undefined || t < c) {
    return { phase: 'search', reveal: 0, comparePos: 0, slowmo: false, compareLoopT: 0 };
  }
  const since = t - c;
  if (since < REVEAL_MS) {
    return {
      phase: 'reveal',
      reveal: since / REVEAL_MS,
      comparePos: 0,
      slowmo: false,
      compareLoopT: 0,
    };
  }
  const loopT = (since - REVEAL_MS) % COMPARE_LOOP_MS;
  const { stepMs, placeOrderMs, breakMs } = COMPARE;
  const p1 = 5 * stepMs;
  const p2 = p1 + placeOrderMs;
  const p3 = p2 + breakMs;
  let pos: number;
  let slowmo = false;
  if (loopT < p1) pos = loopT / stepMs;
  else if (loopT < p2) pos = 5 + (loopT - p1) / placeOrderMs;
  else if (loopT < p3) {
    pos = 6 + (loopT - p2) / breakMs;
    slowmo = true;
  } else pos = 7;
  return { phase: 'compare', reveal: 1, comparePos: pos, slowmo, compareLoopT: loopT };
}
