import { useContext, useState, type ReactNode } from 'react';
import { MediaContext, NoCapture } from './DeviceCard.tsx';
import { OrbitStore, type OrbitScreen } from './OrbitStore.tsx';
import type { Evidence } from '../state/evidence.ts';
import type { CommitSummary } from '../types.ts';

export type DrawerState = 'hidden' | 'peek' | 'open';
export type EvidenceTab = 'visual' | 'network' | 'logs' | 'code';

const TABS: EvidenceTab[] = ['visual', 'network', 'logs', 'code'];

/**
 * How many items each tab has behind it, so an empty tab can say so before it
 * is opened. The alternative is a user clicking `network`, finding nothing,
 * and not knowing whether that is the tool failing or the run being quiet.
 */
function tabCounts(evidence: Evidence): Record<EvidenceTab, number> {
  return {
    visual: evidence.regions.length,
    network: evidence.network.length,
    logs: evidence.logs.length,
    code: evidence.diff.length,
  };
}

/**
 * A tab with nothing behind it says so. The alternative, quietly rendering the
 * demo's numbers, is the failure mode this whole drawer exists to avoid: an
 * invented HTTP call is indistinguishable from a captured one.
 */
function NoEvidence({ what, hint }: { what: string; hint: ReactNode }) {
  return (
    <div className="ev-empty">
      <p className="ev-empty-what">No {what} captured for this run.</p>
      <p className="ev-empty-hint">{hint}</p>
    </div>
  );
}

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
  const synthetic = useContext(MediaContext).synthetic ?? false;
  const [broken, setBroken] = useState(false);
  const showFrame = !!frame && !broken;
  return (
    <figure className="crop-fig" data-tone={tone}>
      <div className="crop" style={{ width: CROP_W, height: CROP_H }}>
        {showFrame ? (
          /* A real capture fills the window and is centred. The offset below is
             tuned to the drawn store's geometry; applying it to a 393x852
             screenshot lands on whatever happens to be at that offset, which
             for a dark launch screen is a black band. */
          <img
            className="crop-frame"
            src={frame}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
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
            {synthetic ? <OrbitStore screen={screen} assert={assert} /> : <NoCapture />}
          </div>
        )}
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
  const counts = tabCounts(evidence);
  return (
    <section className="drawer" data-state={state} style={{ height }}>
      {/* Grabber: the drawer is draggable-looking because it is toggleable. */}
      <button className="drawer-grab" onClick={onToggle} aria-hidden="true" tabIndex={-1}>
        <span />
      </button>
      <div className="drawer-head">
        <div className="drawer-diagnosis">
          <span className="micro" data-tone="red">
            diagnosis
          </span>
          <p>{diagnosis ?? 'The first bad commit changed how the order response is read.'}</p>
        </div>
        <nav className="drawer-tabs">
          {/* Roving tabindex + arrow keys is the WAI-ARIA tabs pattern: one tab
              stop for the whole set, arrows move within it. */}
          <div className="drawer-tablist" role="tablist" aria-label="evidence">
            {TABS.map((t, i) => {
              const on = t === tab;
              const count = counts[t];
              return (
                <button
                  key={t}
                  id={`ev-tab-${t}`}
                  role="tab"
                  aria-selected={on}
                  aria-controls={`ev-panel-${t}`}
                  tabIndex={on ? 0 : -1}
                  className="drawer-tab mono"
                  data-on={on}
                  data-empty={count === 0}
                  onClick={() => onTab(t)}
                  onKeyDown={(e) => {
                    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    const next = TABS[(i + d + TABS.length) % TABS.length]!;
                    onTab(next);
                    document.getElementById(`ev-tab-${next}`)?.focus();
                  }}
                >
                  <span className="drawer-tab-label">{t}</span>
                  {count > 0 && <span className="drawer-tab-count">{count}</span>}
                </button>
              );
            })}
            {/* One sliding rule rather than four static ones: the movement is
                what tells you which way you just went. */}
            <span
              className="drawer-tab-rule"
              aria-hidden="true"
              style={{
                width: `${100 / TABS.length}%`,
                transform: `translateX(${TABS.indexOf(tab) * 100}%)`,
              }}
            />
          </div>
          <button
            className="drawer-toggle"
            onClick={onToggle}
            aria-label={state === 'open' ? 'collapse evidence' : 'expand evidence'}
            aria-expanded={state === 'open'}
          >
            <span data-open={state === 'open'} />
          </button>
        </nav>
      </div>

      <div className="drawer-body" role="tabpanel" id={`ev-panel-${tab}`} aria-labelledby={`ev-tab-${tab}`}>
        {tab === 'visual' && (
          <div className="ev-visual">
            {/* No thumbnails here. The two phones directly above are the same
                two frames, larger and in device aspect; a 250x114 window onto a
                393x852 screenshot is a horizontal band of whatever sat at that
                offset. Repeating evidence worse than it is already shown is not
                more evidence. */}
            <div className="ev-regions">
              {evidence.regions.length === 0 && (
                <NoEvidence
                  what="region analysis"
                  hint="The two frames above are the captured evidence."
                />
              )}
              {evidence.regions.map((r, i) => (
                <div className="ev-region" key={r.title} data-anchor={i === 0 ? 'evidence-focus' : undefined}>
                  <div className="ev-region-title">{r.title}</div>
                  <div className="ev-region-detail">{r.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'network' && evidence.network.length === 0 && (
          <NoEvidence
            what="network trace"
            hint="The runner returns a verdict and frames. Request capture is not wired up yet."
          />
        )}
        {tab === 'network' && evidence.network.length > 0 && (
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

        {tab === 'logs' && evidence.logs.length === 0 && (
          <NoEvidence
            what="device logs"
            hint={
              <>
                <code>revyl device logs</code> only reads while the session is alive, and this
                report was rendered after it stopped.
              </>
            }
          />
        )}
        {tab === 'logs' && evidence.logs.length > 0 && (
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

        {tab === 'code' && evidence.diff.length === 0 && (
          <NoEvidence
            what="diff"
            hint={
              <>
                See the change with <code>git show {badCommit?.shortSha ?? '<first-bad>'}</code>.
              </>
            }
          />
        )}
        {tab === 'code' && evidence.diff.length > 0 && (
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
