import { PhoneFrame } from './PhoneFrame.tsx';
import { PhoneScreen } from './DeviceCard.tsx';
import { screenForStep } from './OrbitStore.tsx';
import { clamp } from '../lib/util.ts';
import type { CommitResult, CommitSummary } from '../types.ts';

const PLAY_H = 64;
/** playhead margin + top padding */
const GAPS = 28;

export interface FinalComparisonProps {
  goodCommit: CommitSummary;
  badCommit: CommitSummary;
  goodResult?: CommitResult;
  badResult?: CommitResult;
  /** Fractional flow position, 0..7, shared by both recordings. */
  pos: number;
  slowmo: boolean;
  stepLabels: string[];
  /** Height the layout is built for (the drawer-collapsed height). */
  height: number;
  /** Uniform shrink applied when the evidence drawer takes the lower screen. */
  fit: number;
  diff: boolean;
  onToggleDiff: () => void;
  onScrubStep: (step: number) => void;
}

function Side({
  tone,
  label,
  commit,
  result,
  pos,
  phoneWidth,
  diff,
  anchor,
}: {
  tone: 'good' | 'bad';
  label: string;
  commit: CommitSummary;
  result?: CommitResult;
  pos: number;
  phoneWidth: number;
  diff?: boolean;
  anchor?: string;
}) {
  const verdict = tone === 'good' ? 'pass' : 'fail';
  const screen = screenForStep(pos, verdict);
  const asserted = pos >= 7;
  return (
    <div className="cmp-side" data-tone={tone}>
      <div className="cmp-label">
        <span className="micro" data-tone={tone}>
          {label}
        </span>
        <span className="mono cmp-hash">{commit.shortSha}</span>
        <span className="cmp-subject">{commit.subject}</span>
        <span className="cmp-meta mono">{commit.author}</span>
        {result?.reason && <span className="cmp-reason">{result.reason}</span>}
      </div>
      <div data-anchor={anchor}>
        <PhoneFrame
          width={phoneWidth}
          glow={tone === 'good' ? 'green' : 'red'}
          flipId={`phone:${commit.shortSha}`}
        >
          <PhoneScreen
            videoUrl={result?.videoUrl}
            frames={result?.screenshots}
            pos={pos}
            screen={screen}
            assert={asserted ? verdict : null}
            diff={diff && tone === 'bad' && asserted}
          />
        </PhoneFrame>
      </div>
    </div>
  );
}

export function FinalComparison({
  goodCommit,
  badCommit,
  goodResult,
  badResult,
  pos,
  slowmo,
  stepLabels,
  height,
  fit,
  diff,
  onToggleDiff,
  onScrubStep,
}: FinalComparisonProps) {
  const phoneWidth = Math.round(clamp((height - PLAY_H - GAPS) / 2.06, 168, 300));
  const shown = clamp(Math.ceil(pos), 1, 7);
  const label = stepLabels[shown - 1] ?? '';

  return (
    <div className="cmp" style={{ height, transform: `scale(${fit})` }}>
      <div className="cmp-row">
        <Side
          tone="good"
          label="last good"
          commit={goodCommit}
          result={goodResult}
          pos={pos}
          phoneWidth={phoneWidth}
        />
        <Side
          tone="bad"
          label="first bad"
          commit={badCommit}
          result={badResult}
          pos={pos}
          phoneWidth={phoneWidth}
          diff={diff}
          anchor="cmp-fail"
        />
      </div>

      <div className="cmp-play">
        <div className="cmp-play-head">
          <span className="micro cmp-play-mode">synchronized step replay</span>
          <span className="mono cmp-play-n">{shown} / 7</span>
          <span className="cmp-play-label">{label}</span>
          {slowmo && <span className="mono cmp-slow">0.5×</span>}
        </div>
        <div className="cmp-track">
          <div className="cmp-track-fill" style={{ width: `${(pos / 7) * 100}%` }} />
          {stepLabels.map((l, i) => (
            <button
              key={l + i}
              className="cmp-tick"
              style={{ left: `${((i + 1) / 7) * 100}%` }}
              data-on={pos >= i + 1}
              onClick={() => onScrubStep(i + 1)}
              aria-label={l}
            />
          ))}
          <div className="cmp-play-dot" style={{ left: `${(pos / 7) * 100}%` }} data-slow={slowmo} />
        </div>
        <button className="cmp-diff-toggle mono" data-on={diff} onClick={onToggleDiff}>
          visual diff {diff ? 'on' : 'off'}
        </button>
      </div>
    </div>
  );
}
