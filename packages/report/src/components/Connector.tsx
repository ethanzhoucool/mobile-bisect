import { useEffect, useRef, useState } from 'react';
import { clamp } from '../lib/util.ts';

interface Pt {
  x: number;
  y: number;
}

/**
 * Draws the reveal line (culprit node -> failed phone) and the evidence line
 * (failed region -> evidence card). Endpoints are measured every frame while
 * active so the line tracks the FLIP transitions instead of snapping after.
 */
export function Connector({
  from,
  to,
  active,
  progress = 1,
  scale,
  tone = 'red',
  stopAtDrawer = false,
}: {
  from: string;
  to: string;
  active: boolean;
  progress?: number;
  scale: number;
  tone?: 'red' | 'muted';
  /** End on the drawer's top edge instead of crossing its content. */
  stopAtDrawer?: boolean;
}) {
  const [pts, setPts] = useState<{ a: Pt; b: Pt; keepOutY?: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    if (!active) {
      setPts(null);
      return;
    }
    const root = document.querySelector('.app');
    const measure = () => {
      const ae = document.querySelector(`[data-anchor="${from}"]`);
      const be = document.querySelector(`[data-anchor="${to}"]`);
      if (root && ae && be) {
        const r0 = root.getBoundingClientRect();
        const ra = ae.getBoundingClientRect();
        const rb = be.getBoundingClientRect();
        const drawer = stopAtDrawer ? document.querySelector('.drawer') : null;
        const edge = drawer ? (drawer.getBoundingClientRect().top - r0.top) / scale : undefined;
        setPts({
          a: { x: (ra.left + ra.width / 2 - r0.left) / scale, y: (ra.bottom - r0.top) / scale },
          // Into the drawer: stop on its top edge, as straight down from the
          // phone as the target allows. Onto a phone: tuck just under its top
          // edge so the line reads as landing on the device.
          b: {
            x:
              edge === undefined
                ? (rb.left + rb.width / 2 - r0.left) / scale
                : clamp(
                    (ra.left + ra.width / 2 - r0.left) / scale,
                    (rb.left - r0.left) / scale + 44,
                    (rb.right - r0.left) / scale - 44,
                  ),
            y: edge ?? (rb.top - r0.top) / scale + 26,
          },
          keepOutY: (() => {
            const head = be.closest('.dc')?.querySelector('.dc-head');
            if (!head) return undefined;
            return (head.getBoundingClientRect().top - r0.top) / scale - 10;
          })(),
        });
      }
      raf.current = requestAnimationFrame(measure);
    };
    raf.current = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf.current);
  }, [active, from, to, scale, stopAtDrawer]);

  if (!pts || !active) return null;
  const { a, b } = pts;
  // The horizontal run must clear the card's label row, crossing it reads as a
  // strikethrough on the commit subject, and this is the reveal frame.
  const midY = stopAtDrawer ? b.y - 20 : Math.min(a.y + (b.y - a.y) * 0.55, pts.keepOutY ?? Infinity);
  const d = `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
  const len = Math.abs(midY - a.y) + Math.abs(b.x - a.x) + Math.abs(b.y - midY);

  return (
    <svg className="connector" data-tone={tone} width={1440} height={900} aria-hidden>
      <path
        d={d}
        className="connector-path"
        style={{ strokeDasharray: len, strokeDashoffset: len * (1 - progress) }}
      />
      <circle cx={a.x} cy={a.y} r={3.5} className="connector-dot" />
      {progress > 0.98 && <circle cx={b.x} cy={b.y} r={3.5} className="connector-dot" />}
    </svg>
  );
}
