import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from './util.ts';

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export interface Clock {
  t: number;
  playing: boolean;
  speed: number;
  seek: (t: number) => void;
  setPlaying: (p: boolean) => void;
  toggle: () => void;
  setSpeed: (s: number) => void;
  nudgeSpeed: (dir: 1 | -1) => void;
}

/**
 * Virtual-time clock. Everything on screen is a pure function of `t`, so a
 * scrub and a live playhead produce byte-identical frames — that is what makes
 * the report safe to screen-record and re-record.
 */
export function useClock(opts: {
  duration: number;
  autoplay?: boolean;
  initialTime?: number;
  initialSpeed?: number;
  loop?: boolean;
}): Clock {
  const { duration, autoplay = true, initialTime = 0, initialSpeed = 1, loop = false } = opts;
  const [t, setT] = useState(initialTime);
  const [playing, setPlaying] = useState(autoplay);
  const [speed, setSpeed] = useState(initialSpeed);
  const raf = useRef(0);
  const last = useRef(0);
  const durRef = useRef(duration);
  durRef.current = duration;

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= durRef.current) {
          if (loop) return next % durRef.current;
          setPlaying(false);
          return durRef.current;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, loop]);

  const seek = useCallback((next: number) => setT(clamp(next, 0, durRef.current)), []);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && durRef.current > 0) setT((cur) => (cur >= durRef.current - 1 ? 0 : cur));
      return !p;
    });
  }, []);
  const nudgeSpeed = useCallback((dir: 1 | -1) => {
    setSpeed((s) => {
      const i = SPEEDS.indexOf(s);
      return SPEEDS[clamp((i < 0 ? 2 : i) + dir, 0, SPEEDS.length - 1)];
    });
  }, []);

  return { t, playing, speed, seek, setPlaying, toggle, setSpeed, nudgeSpeed };
}
