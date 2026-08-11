import { useMemo, useState } from 'react';
import type { ActiveRange, CommitState, CommitSummary } from '../types.ts';
import { layoutRail } from '../lib/railLayout.ts';
import { useFlip } from '../lib/flip.ts';
import { easeOut, fmtDate, spanned } from '../lib/util.ts';

export interface CommitRailProps {
  commits: CommitSummary[];
  states: CommitState[];
  range: ActiveRange;
  width: number;
  /** 0 = no reveal in progress, 1 = fully revealed. */
  reveal: number;
  compact: boolean;
  culpritIndex?: number;
  goodIndex?: number;
  candidateSha?: string;
  label: string;
  scale: number;
}

const HIT = 44;

export function CommitRail({
  commits,
  states,
  range,
  width,
  reveal,
  compact,
  culpritIndex,
  goodIndex,
  candidateSha,
  label,
  scale,
}: CommitRailProps) {
  const [hover, setHover] = useState<number | null>(null);

  // Scripted reveal beats, all pure functions of `reveal`, so scrubbing
  // backwards replays them exactly.
  const spread = easeOut(spanned(reveal, 0, 0.17)) * 24;
  const dim = spanned(reveal, 0.29, 0.54);
  const grow = easeOut(spanned(reveal, 0.46, 0.78));

  const { nodes, bracket } = useMemo(
    () => layoutRail(commits.length, range, width, { spread }),
    [commits.length, range[0], range[1], width, spread],
  );

  const railRef = useFlip<HTMLDivElement>('.node', [nodes, compact], {
    duration: 560,
    scale,
  });

  const candidateIndex = commits.findIndex((c) => c.sha === candidateSha);
  const tagged = new Set<number>();
  if (candidateIndex >= 0 && reveal === 0) tagged.add(candidateIndex);
  if (reveal > 0 && culpritIndex !== undefined) tagged.add(culpritIndex);
  if (reveal > 0 && goodIndex !== undefined) tagged.add(goodIndex);
  if (hover !== null) tagged.add(hover);

  const hovered = hover !== null ? commits[hover] : null;

  return (
    <div className="rail" data-compact={compact} ref={railRef} style={{ width }}>
      <div className="rail-base" />
      {bracket && (
        <div
          className="rail-bracket"
          style={{ left: bracket.x1, width: Math.max(2, bracket.x2 - bracket.x1) }}
          data-culprit={reveal > 0}
        />
      )}
      {bracket && (
        <div
          className="rail-label micro"
          style={{ left: (bracket.x1 + bracket.x2) / 2 }}
          data-culprit={reveal > 0}
        >
          {label}
        </div>
      )}

      {nodes.map((n) => {
        const isCulprit = culpritIndex === n.index && reveal > 0;
        const isBoundary = goodIndex === n.index && reveal > 0;
        // Dim, never erase: the eliminated history has to stay legible so the
        // audience can still see how wide the search started.
        const dimmed = reveal > 0 && !isCulprit && !isBoundary ? dim * 0.45 : 0;
        return (
          <button
            key={commits[n.index].sha}
            className="node flip"
            data-flip-id={`n${n.index}`}
            data-state={states[n.index]}
            data-active={n.active}
            data-culprit={isCulprit || undefined}
            data-tight={n.slot < 12 || undefined}
            style={{
              left: n.x - HIT / 2,
              opacity: 1 - dimmed,
              // @ts-expect-error custom property
              '--grow': isCulprit ? 1 + 0.8 * grow : 1,
            }}
            onMouseEnter={() => setHover(n.index)}
            onMouseLeave={() => setHover((h) => (h === n.index ? null : h))}
            aria-label={commits[n.index].shortSha}
            data-anchor={isCulprit ? 'culprit-node' : undefined}
          >
            <span className="dot" />
          </button>
        );
      })}

      {!compact &&
        Array.from(tagged).map((i) => (
          <span
            key={`t${i}`}
            className="node-tag mono"
            style={{ left: nodes[i]?.x ?? 0 }}
            data-state={states[i]}
            data-culprit={culpritIndex === i && reveal > 0 ? '' : undefined}
          >
            {commits[i].shortSha}
          </span>
        ))}

      {!compact && hovered && (
        <div className="node-pop" style={{ left: nodes[hover!]?.x ?? 0 }}>
          <div className="node-pop-subject">{hovered.subject}</div>
          <div className="node-pop-meta mono">
            {hovered.author} · {fmtDate(hovered.authoredAt)} · #{hovered.index}
          </div>
        </div>
      )}
    </div>
  );
}
