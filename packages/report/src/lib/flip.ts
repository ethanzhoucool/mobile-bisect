import { useLayoutEffect, useRef } from 'react';

export interface FlipOptions {
  /** ms */
  duration?: number;
  easing?: string;
  /** Extra ms per element, ordered by document position. */
  stagger?: number;
  /** Uniform scale applied by an ancestor transform; deltas are divided by it. */
  scale?: number;
  /** Skip the invert/play pass entirely (e.g. while scrubbing). */
  enabled?: boolean;
}

type Snapshot = Map<string, { x: number; y: number; w: number; h: number }>;

function snapshot(root: HTMLElement, selector: string, scale: number): Snapshot {
  const map: Snapshot = new Map();
  const nodes = root.querySelectorAll<HTMLElement>(selector);
  for (const el of nodes) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    map.set(id, { x: r.left / scale, y: r.top / scale, w: r.width / scale, h: r.height / scale });
  }
  return map;
}

/**
 * First/Last/Invert/Play against real measured boxes.
 *
 * Nodes are laid out with `left`, not `transform`, so the browser genuinely
 * re-lays them out and we animate the difference. That is what keeps the rail
 * spatially continuous: an element that moves 600px across the screen is the
 * same DOM node the whole way, never an unmount/remount.
 */
export function useFlip<T extends HTMLElement>(
  selector: string,
  deps: unknown[],
  opts: FlipOptions = {},
) {
  const {
    duration = 520,
    easing = 'cubic-bezier(0.22, 0.65, 0.24, 1)',
    stagger = 0,
    scale = 1,
    enabled = true,
  } = opts;
  const rootRef = useRef<T | null>(null);
  const prev = useRef<Snapshot | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const last = snapshot(root, selector, scale);
    const first = prev.current;
    prev.current = last;
    if (!first || !enabled) return;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector));
    let moved = 0;
    for (const el of nodes) {
      const id = el.dataset.flipId;
      if (!id) continue;
      const a = first.get(id);
      const b = last.get(id);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const ds = b.w > 0 ? a.w / b.w : 1;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(ds - 1) < 0.02) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${ds})`;
      moved++;
    }
    if (!moved) return;

    // One forced reflow for the whole batch, then release everything together.
    void root.offsetWidth;
    nodes.forEach((el, i) => {
      if (el.style.transform === '') return;
      el.style.transition = `transform ${duration}ms ${easing} ${i * stagger}ms`;
      el.style.transform = '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}
