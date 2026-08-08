import type { ActiveRange } from '../types.ts';

export interface RailNodeLayout {
  index: number;
  /** Centre x in rail-local px. */
  x: number;
  /** Slot width, used to derive dot size for the compressed history. */
  slot: number;
  active: boolean;
}

export interface RailLayout {
  nodes: RailNodeLayout[];
  bracket: { x1: number; x2: number } | null;
}

const MAX_ACTIVE_SLOT = 92;
const MIN_SLOT = 6;

/**
 * Positions every commit on the rail. Eliminated commits are never removed —
 * they keep a (shrinking) slot so the audience can still see how wide the
 * search started. The live range is pulled to the centre and given as much room
 * as it can use, which is what makes each round feel like a collapse.
 */
export function layoutRail(
  count: number,
  range: ActiveRange,
  width: number,
  opts: { spread?: number } = {},
): RailLayout {
  if (count <= 0) return { nodes: [], bracket: null };
  const a = Math.max(0, Math.min(range[0], count - 1));
  const b = Math.max(a, Math.min(range[1], count - 1));
  const activeCount = b - a + 1;
  const leftCount = a;
  const rightCount = count - 1 - b;

  // Blend from "everything is active" (round 1 looks like an even row of 64)
  // toward a fixed 62% centre band as the search collapses.
  const collapse = 1 - activeCount / count;
  const frac = 0.62 * collapse + (activeCount / count) * (1 - collapse);
  const activeWidth = Math.min(frac * width, activeCount * MAX_ACTIVE_SLOT);
  const activeSlot = activeWidth / activeCount;
  const start = (width - activeWidth) / 2;
  const leftSlot = leftCount > 0 ? Math.max(MIN_SLOT, start / leftCount) : 0;
  const rightSlot = rightCount > 0 ? Math.max(MIN_SLOT, (width - start - activeWidth) / rightCount) : 0;

  const spread = opts.spread ?? 0;
  const nodes: RailNodeLayout[] = [];
  for (let i = 0; i < count; i++) {
    let x: number;
    let slot: number;
    if (i < a) {
      slot = leftSlot;
      x = start - (a - i) * leftSlot + leftSlot / 2;
    } else if (i > b) {
      slot = rightSlot;
      x = start + activeWidth + (i - b - 1) * rightSlot + rightSlot / 2;
    } else {
      slot = activeSlot;
      x = start + (i - a) * activeSlot + activeSlot / 2;
    }
    // Culprit reveal: push the final pair apart around the rail centre.
    if (spread > 0 && i >= a && i <= b) {
      const mid = (a + b) / 2;
      x += Math.sign(i - mid || 1) * spread;
    }
    nodes.push({ index: i, x, slot, active: i >= a && i <= b });
  }

  const bracket =
    activeCount > 0
      ? { x1: nodes[a].x - activeSlot / 2 + 4, x2: nodes[b].x + activeSlot / 2 - 4 }
      : null;
  return { nodes, bracket };
}
