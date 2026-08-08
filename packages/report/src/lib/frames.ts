import { clamp } from './util.ts';

/**
 * Revyl gives us an ordered array of per-step PNGs
 * (screenshot_before_url + screenshot_after_url for each flow step), not a
 * session video. So the comparison is a step-indexed frame replay: two runs,
 * one playhead, the same step index on both phones.
 *
 * `pos` is the fractional flow position (0..total). For the usual 2-frames-per-
 * step layout, floor(pos * 2) lands on before/after exactly; anything else is
 * mapped proportionally so odd artifact counts still replay in order.
 */
export function frameIndexFor(pos: number, count: number, totalSteps: number): number {
  if (count <= 0) return -1;
  if (count === totalSteps * 2) return clamp(Math.floor(pos * 2), 0, count - 1);
  if (count === totalSteps) return clamp(Math.ceil(pos) - 1, 0, count - 1);
  return clamp(Math.round((pos / totalSteps) * (count - 1)), 0, count - 1);
}

/** Which flow step a frame belongs to, for the "step N of M" readout. */
export function stepOfFrame(index: number, count: number, totalSteps: number): number {
  if (count === totalSteps * 2) return Math.floor(index / 2) + 1;
  if (count === totalSteps) return index + 1;
  return clamp(Math.round((index / Math.max(1, count - 1)) * totalSteps), 1, totalSteps);
}
