import { useEffect, useRef, useState } from 'react';
import type { BisectMeta } from '../types.ts';

/** Re-keys on change so the value can play a short slide, nothing more. */
function Num({ value, className }: { value: string | number; className?: string }) {
  const [key, setKey] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setKey((k) => k + 1);
    }
  }, [value]);
  return (
    <span key={key} className={`num${className ? ` ${className}` : ''}`}>
      {value}
    </span>
  );
}

export interface CommandBarProps {
  meta?: BisectMeta;
  round: number;
  remaining: number;
  done: boolean;
  live: boolean;
}

export function CommandBar({ meta, round, remaining, done, live }: CommandBarProps) {
  if (!meta) return <header className="bar" />;
  return (
    <header className="bar">
      <div className="bar-left mono">
        <span className="bar-brand">expo-bisect</span>
        <i className="sep" />
        <span>{meta.flowName}</span>
        <i className="sep" />
        <span>
          {meta.goodRef}..{meta.badRef}
        </span>
        <i className="sep" />
        <span className="bar-expect">
          <span className="c-muted">expected:</span> {meta.expect}
        </span>
      </div>
      <div className="bar-right mono">
        {live && <span className="bar-live">live</span>}
        {done ? (
          <span className="bar-done">culprit found</span>
        ) : (
          <>
            <span className="c-muted">
              round <Num value={round || 1} className="c-text" /> of {meta.plannedRounds}
            </span>
            <i className="sep" />
            <span className="c-muted">
              <Num value={remaining} className="c-text" /> of {meta.totalCommits} remain
            </span>
          </>
        )}
      </div>
    </header>
  );
}
