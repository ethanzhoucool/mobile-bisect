import { useState } from 'react';
import { OrbitStore, type OrbitScreen } from './OrbitStore.tsx';
import type { Evidence } from '../state/evidence.ts';
import type { CommitSummary } from '../types.ts';

export type DrawerState = 'hidden' | 'peek' | 'open';
export type EvidenceTab = 'visual' | 'network' | 'logs' | 'code';

const TABS: EvidenceTab[] = ['visual', 'network', 'logs', 'code'];

const CROP_W = 250;
const CROP_H = 114;

/**
 * A clipped window onto the final step — the captured frame when the run has
 * one, the drawn placeholder otherwise. Both crop identically so the good/bad
 * pair always lines up region for region.
 */
function Crop({
  screen,
  assert,
  tone,
  caption,
  frame,
}: {
  screen: OrbitScreen;
  assert: 'pass' | 'fail' | null;
  tone: 'good' | 'bad';
  caption: string;
  frame?: string;
}) {
  const sw = 236;
  const [broken, setBroken] = useState(false);
  const showFrame = !!frame && !broken;
  return (
    <figure className="crop-fig" data-tone={tone}>
      <div className="crop" style={{ width: CROP_W, height: CROP_H }}>
        <div
          className="crop-inner"
          style={{
            width: sw,
            height: sw * 2.02,
            // @ts-expect-error custom property
            '--sw': `${sw}px`,
            '--u': `${sw / 100}px`,
            transform: `translate(7px, -48px)`,
          }}
        >
          {showFrame ? (
            <img
              className="crop-frame"
              src={frame}
              alt=""
              draggable={false}
              onError={() => setBroken(true)}
            />
          ) : (
            <OrbitStore screen={screen} assert={assert} />
          )}
        </div>
      </div>
      <figcaption className="micro" data-tone={tone}>
        {caption}
      </figcaption>
    </figure>
  );
}

export interface EvidenceDrawerProps {
  state: DrawerState;
  tab: EvidenceTab;
  onTab: (t: EvidenceTab) => void;
  onToggle: () => void;
  diagnosis?: string;
  evidence: Evidence;
  goodCommit?: CommitSummary;
  badCommit?: CommitSummary;
  /** Final captured frame for each side, when the run has them. */
  goodFrame?: string;
  badFrame?: string;
  height: number;
}

export function EvidenceDrawer({
  state,
  tab,
  onTab,
  onToggle,
  diagnosis,
  evidence,
  goodCommit,
  badCommit,
  goodFrame,
  badFrame,
  height,
}: EvidenceDrawerProps) {
  return (
    <section className="drawer" data-state={state} style={{ height }}>
      <div className="drawer-head">
        <div className="drawer-diagnosis">
          <span className="micro" data-tone="red">
            diagnosis
          </span>
          <p>{diagnosis ?? 'The first bad commit changed how the order response is read.'}</p>
        </div>
        <nav className="drawer-tabs">
          {TABS.map((t) => (
            <button key={t} className="drawer-tab mono" data-on={t === tab} onClick={() => onTab(t)}>
              {t}
            </button>
          ))}
          <button className="drawer-toggle" onClick={onToggle} aria-label="toggle evidence">
            <span data-open={state === 'open'} />
          </button>
        </nav>
      </div>

      <div className="drawer-body">
        {tab === 'visual' && (
          <div className="ev-visual">
            <Crop
              screen="confirmed"
              assert="pass"
              tone="good"
              frame={goodFrame}
              caption={`last good · ${goodCommit?.shortSha ?? ''}`}
            />
            <Crop
              screen="stuck"
              assert="fail"
              tone="bad"
              frame={badFrame}
              caption={`first bad · ${badCommit?.shortSha ?? ''}`}
            />
            <div className="ev-regions">
              {evidence.regions.map((r, i) => (
                <div className="ev-region" key={r.title} data-anchor={i === 0 ? 'evidence-focus' : undefined}>
                  <div className="ev-region-title">{r.title}</div>
                  <div className="ev-region-detail">{r.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'network' && (
          <div className="ev-net mono">
            {evidence.network.map((r) => (
              <div className="ev-net-row" key={r.method + r.path} data-flag={r.flag} data-anchor={r.flag === 'key' ? 'evidence-focus' : undefined}>
                <span className="ev-net-method">{r.method}</span>
                <span className="ev-net-path">{r.path}</span>
                <span className="ev-net-status" data-missing={r.status === '—'}>
                  {r.status}
                </span>
                <span className="ev-net-ms">{r.ms === '—' ? '—' : `${r.ms}ms`}</span>
                <span className="ev-net-note">{r.note}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'logs' && (
          <div className="ev-logs mono">
            {evidence.logs.map((l, i) => (
              <div className="ev-log" key={i} data-level={l.level} data-flag={l.flag} data-anchor={l.flag && i === 2 ? 'evidence-focus' : undefined}>
                <span className="ev-log-time">{l.time}</span>
                <span className="ev-log-level">{l.level}</span>
                <span className="ev-log-tag">[{l.tag}]</span>
                <span className="ev-log-msg">{l.message}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'code' && (
          <div className="ev-code">
            <div className="ev-code-head mono">
              <span className="c-muted">{badCommit?.shortSha}</span> {evidence.diffFile}
            </div>
            <div className="ev-diff mono">
              {evidence.diff.map((l, i) => (
                <div className="ev-diff-line" key={i} data-kind={l.kind.trim() || 'ctx'} data-flag={l.flag} data-anchor={l.flag ? 'evidence-focus' : undefined}>
                  <span className="ev-diff-gutter">{l.kind}</span>
                  <span>{l.text}</span>
                  {l.flag && <span className="ev-cause micro">likely cause</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
