import { useCallback, useRef } from 'react';
import { SPEEDS, type Clock } from '../lib/useClock.ts';
import { fmtClock } from '../lib/util.ts';
import type { Timeline } from '../state/timeline.ts';

export function ReplayControls({
  clock,
  timeline,
  live,
  following,
  onFollow,
}: {
  clock: Clock;
  timeline: Timeline;
  live: boolean;
  following?: boolean;
  onFollow?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      clock.seek(((clientX - r.left) / r.width) * timeline.duration);
    },
    [clock, timeline.duration],
  );

  const onDown = (e: React.MouseEvent) => {
    seekFromEvent(e.clientX);
    const move = (ev: MouseEvent) => seekFromEvent(ev.clientX);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const pct = (clock.t / timeline.duration) * 100;

  return (
    <footer className="controls">
      {live ? (
        <button className="ctl-live mono" data-on={following} onClick={onFollow}>
          <i /> {following ? 'following live' : 'paused — jump to live'}
        </button>
      ) : (
        <button className="ctl-play" onClick={clock.toggle} aria-label={clock.playing ? 'pause' : 'play'}>
          {clock.playing ? (
            <svg viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1.2" />
              <rect x="14" y="4" width="4" height="16" rx="1.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24">
              <path d="M7 4.5 L19.5 12 L7 19.5 Z" />
            </svg>
          )}
        </button>
      )}

      <span className="ctl-time mono">
        {fmtClock(clock.t)} <span className="c-muted">/ {fmtClock(timeline.duration)}</span>
      </span>

      <div className="ctl-track" ref={trackRef} onMouseDown={onDown}>
        <div className="ctl-track-bg" />
        <div className="ctl-track-fill" style={{ width: `${pct}%` }} />
        {timeline.roundStarts.map((r) => (
          <i
            key={r.round}
            className="ctl-tick"
            style={{ left: `${(r.at / timeline.duration) * 100}%` }}
            data-passed={clock.t >= r.at}
          />
        ))}
        {timeline.culpritAt !== undefined && (
          <i
            className="ctl-tick"
            data-culprit
            style={{ left: `${(timeline.culpritAt / timeline.duration) * 100}%` }}
          />
        )}
        <i className="ctl-head" style={{ left: `${pct}%` }} />
      </div>

      <div className="ctl-speeds mono">
        {SPEEDS.map((s) => (
          <button key={s} data-on={clock.speed === s} onClick={() => clock.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </footer>
  );
}
