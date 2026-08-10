import { clamp } from './util.ts';

/**
 * Revyl gives us an ordered array of per-step PNGs
 * (screenshot_before_url + screenshot_after_url for each flow step), not a
 * session video. So the comparison is a step-indexed frame replay: two runs,
 * one playhead, the same step index on both phones.
 *
 * Two ways to line a frame up with a step, in order of preference:
 *
 *   1. Read it off the filename. Captures are written as
 *      `step-03-action-00-after.png`, which says exactly which step produced
 *      the frame and whether it is the before or after shot. This is the only
 *      mapping that survives a run whose frame count is not a tidy multiple of
 *      the step count, which is most of them: retries, live shots and
 *      before-only steps all skew the total.
 *   2. Fall back to proportional indexing when the names carry no step, which
 *      is what presigned S3 URLs look like.
 *
 * Getting this wrong is what makes the payoff comparison show two identical
 * home screens: the flow's first frame is captured before the app has finished
 * launching, so a naive `index = pos - 1` lands on the springboard.
 */

/** `.../step-03-action-00-after.png` -> `{ step: 3, action: 0, after: true }`. */
export interface FrameId {
  step: number;
  action: number;
  after: boolean;
}

export function parseFrameName(path: string): FrameId | undefined {
  const name = path.split(/[\\/]/).pop() ?? path;
  const m = /step-(\d+)(?:-action-(\d+))?(?:-(before|after|live))?/i.exec(name);
  if (!m) return undefined;
  return {
    step: Number(m[1]),
    action: m[2] ? Number(m[2]) : 0,
    // A `live` shot is taken while the step runs, so it shows the outcome of
    // whatever came before it, not of its own step.
    after: m[3] !== 'before' && m[3] !== 'live',
  };
}

/** True when the names carry step numbers we can trust for playback. */
export function framesAreStepped(frames: string[]): boolean {
  if (frames.length === 0) return false;
  return frames.every((f) => parseFrameName(f) !== undefined);
}

/**
 * The frame to show at flow position `pos`.
 *
 * With stepped names this is the *last* frame of the highest step at or below
 * `pos`, preferring an `after` shot — the state the app settled into once that
 * step finished, which is what a viewer is trying to compare.
 */
export function frameIndexFor(pos: number, count: number, totalSteps: number, frames?: string[]): number {
  if (count <= 0) return -1;

  if (frames && frames.length === count && framesAreStepped(frames)) {
    const step = clamp(Math.ceil(pos), 1, totalSteps);
    let best = -1;
    let bestKey = -1;
    for (let i = 0; i < frames.length; i++) {
      const id = parseFrameName(frames[i]!)!;
      if (id.step > step) continue;
      // Order within a step: after beats before, later action beats earlier.
      const key = id.step * 1000 + id.action * 2 + (id.after ? 1 : 0);
      if (key >= bestKey) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) return best;
  }

  if (count === totalSteps * 2) return clamp(Math.floor(pos * 2), 0, count - 1);
  if (count === totalSteps) return clamp(Math.ceil(pos) - 1, 0, count - 1);
  return clamp(Math.round((pos / totalSteps) * (count - 1)), 0, count - 1);
}

/** Which flow step a frame belongs to, for the "step N of M" readout. */
export function stepOfFrame(index: number, count: number, totalSteps: number, frames?: string[]): number {
  if (frames && frames.length === count && framesAreStepped(frames)) {
    const id = parseFrameName(frames[index] ?? '');
    if (id) return clamp(id.step, 1, totalSteps);
  }
  if (count === totalSteps * 2) return Math.floor(index / 2) + 1;
  if (count === totalSteps) return index + 1;
  return clamp(Math.round((index / Math.max(1, count - 1)) * totalSteps), 1, totalSteps);
}
