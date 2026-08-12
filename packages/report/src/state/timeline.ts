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

/**
 * Dead air, and what it is worth watching.
 *
 * Most of a round is spent compiling the candidate and booting a device: about
 * 75 seconds of every 130, with nothing on screen. Played at full length that
 * is most of a recording.
 *
 * Which stretches are dead is decided by what ends them, not by how long they
 * are. A duration threshold cannot separate "compiling for 50 seconds" from
 * "the agent is working through a step for 20", and collapsing the second
 * would throw away the part worth watching. The waits that end when a
 * candidate finally starts running, or when its first step lands, are the ones
 * with nothing in them.
 */
export const IDLE_KEEP_MS = 800;

export interface BuildTimelineOptions {
  /** Collapse the stretches where nothing is happening. */
  skipIdle?: boolean;
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

/**
 * Rewrites event times so the waiting between them is short.
 *
 * Only the spacing changes; the order and the events themselves do not, so
 * every consumer of a mark keeps working and the compression is invisible
 * beyond the scrubber running shorter.
 */
function endsAWait(ev: BisectEvent): boolean {
  // The device came up, or the app finally answered.
  return ev.type === 'commit.running' || (ev.type === 'flow.step' && ev.index === 1);
}

function collapseIdle(marks: TimelineMark[]): TimelineMark[] {
  const out: TimelineMark[] = [];
  let prevRaw = 0;
  let shift = 0;
  for (const m of marks) {
    const gap = m.at - prevRaw;
    if (endsAWait(m.ev) && gap > IDLE_KEEP_MS) shift += gap - IDLE_KEEP_MS;
    prevRaw = m.at;
    out.push({ at: Math.max(0, m.at - shift), ev: m.ev });
  }
  return out;
}

export function buildTimeline(
  events: BisectEvent[],
  options: BuildTimelineOptions = {},
): Timeline {
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
  });

  const timed = options.skipIdle ? collapseIdle(marks) : marks;
  for (const m of timed) {
    if (m.ev.type === 'round.started') roundStarts.push({ round: m.ev.round, at: m.at });
    if (m.ev.type === 'culprit.found') culpritAt = m.at;
  }

  const last = timed.length ? timed[timed.length - 1].at : 0;
  const tail = culpritAt !== undefined ? culpritAt + REVEAL_MS + COMPARE_LOOP_MS : last;
  return {
    marks: timed,
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
