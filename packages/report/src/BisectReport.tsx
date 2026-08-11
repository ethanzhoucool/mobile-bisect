import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommitResult, BisectEvent } from './types.ts';
import { remainingCount } from './state/model.ts';
import { buildTimeline, sceneAt, stateAt, REVEAL_MS } from './state/timeline.ts';
import { evidenceFor } from './state/evidence.ts';
import { useClock } from './lib/useClock.ts';
import { clamp, spanned } from './lib/util.ts';
import { CommandBar } from './components/CommandBar.tsx';
import { CommitRail } from './components/CommitRail.tsx';
import { DeviceStage } from './components/DeviceStage.tsx';
import { FinalComparison } from './components/FinalComparison.tsx';
import { EvidenceDrawer, type DrawerState, type EvidenceTab } from './components/EvidenceDrawer.tsx';
import { ReplayControls } from './components/ReplayControls.tsx';
import { Connector } from './components/Connector.tsx';
import { MediaContext } from './components/DeviceCard.tsx';

export const DESIGN_W = 1440;
export const DESIGN_H = 900;
const BAR_H = 56;
const RAIL_SEARCH = 140;
const RAIL_COMPACT = 92;
const CONTROLS_H = 64;
const DRAWER_PEEK = 92;
const DRAWER_OPEN = 268;
const RAIL_PAD = 56;
/** How long the comparison plays with the evidence open before it collapses. */
const EVIDENCE_HOLD_MS = 13000;

/** Local copies first: they never expire and they survive an offline report. */
function captured(result?: { localPaths?: string[]; screenshots?: string[] }): string[] | undefined {
  return result?.localPaths?.length ? result.localPaths : result?.screenshots;
}

/** Final captured frame, skipping links a file:// report can't load. */
function lastFrame(
  frames: string[] | undefined,
  allowRemote: boolean,
  table?: Record<string, string>,
): string | undefined {
  const usable = (frames ?? [])
    .map((f) => table?.[f] ?? f)
    .filter((f) => allowRemote || !/^[a-z][a-z0-9+.-]*:\/\//i.test(f));
  return usable[usable.length - 1];
}

/** Any run's step marks, for a report whose culprit pair captured none. */
function firstSteps<T>(steps: Map<string, T[]>): T[] | undefined {
  for (const marks of steps.values()) if (marks.length) return marks;
  return undefined;
}

/** Only for a stream that carried no `flow.step` events at all. */
const FALLBACK_STEPS = [
  'Launch Orbit Store',
  'Open featured product',
  'Tap "Add to cart"',
  'Open cart',
  'Apply coupon SAVE10',
  'Tap "Place order"',
  'Assert order confirmation',
];

export interface BisectReportProps {
  events: BisectEvent[];
  mode?: 'live' | 'replay';
  /** Live mode: SSE endpoint that tails events.jsonl. */
  sseUrl?: string;
  /** 4-up parallel device stage for the launch demo. */
  parallel?: number | boolean;
  /** Dev affordances (replay controls, hover tooltips). `?chrome=off` clears it. */
  chrome?: boolean;
  autoplay?: boolean;
  initialTime?: number;
  initialSpeed?: number;
  /** Allow http(s) artifact URLs. Off by default so file:// reports stay offline. */
  allowRemoteMedia?: boolean;
  /** originalUrl -> data: URI table written by renderReport. */
  frameData?: Record<string, string>;
  /** Capture affordances: pin the drawer/tab/diff state for a clean frame. */
  initialTab?: EvidenceTab;
  initialDrawer?: DrawerState | null;
  initialDiff?: boolean;
}

export function BisectReport({
  events: initialEvents,
  mode = 'replay',
  sseUrl,
  parallel = 0,
  chrome = true,
  autoplay = true,
  initialTime = 0,
  initialSpeed = 1,
  allowRemoteMedia = false,
  frameData,
  initialTab = 'visual',
  initialDrawer = null,
  initialDiff = false,
}: BisectReportProps) {
  const live = mode === 'live';
  const [events, setEvents] = useState<BisectEvent[]>(initialEvents);
  const [following, setFollowing] = useState(live);
  const [drawerOverride, setDrawerOverride] = useState<DrawerState | null>(initialDrawer);
  const [tab, setTab] = useState<EvidenceTab>(initialTab);
  const [diff, setDiff] = useState(initialDiff);
  const [scale, setScale] = useState(1);

  // --- live tail -----------------------------------------------------------
  useEffect(() => {
    if (!live || !sseUrl) return;
    const es = new EventSource(sseUrl);
    es.addEventListener('bisect', (e) => {
      try {
        setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data)]);
      } catch {
        /* ignore malformed line */
      }
    });
    return () => es.close();
  }, [live, sseUrl]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const clock = useClock({
    duration: timeline.duration,
    autoplay: autoplay && !live,
    initialTime,
    initialSpeed,
  });

  // Live mode pins the playhead to the newest event unless the user scrubs off.
  const lastMark = timeline.marks.length ? timeline.marks[timeline.marks.length - 1].at : 0;
  useEffect(() => {
    if (live && following) {
      clock.seek(Math.max(lastMark, clock.t));
      clock.setPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, following, lastMark]);

  const t = clock.t;
  const state = useMemo(() => stateAt(timeline, t), [timeline, t]);
  const scene = useMemo(() => sceneAt(timeline, t), [timeline, t]);

  // --- fit the fixed 1440x900 design into whatever window we are in --------
  useLayoutEffect(() => {
    const fit = () =>
      setScale(Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H, 1.6));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // --- keyboard ------------------------------------------------------------
  const clockRef = useRef(clock);
  clockRef.current = clock;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = clockRef.current;
      if (e.key === ' ') {
        e.preventDefault();
        c.toggle();
      } else if (e.key === 'ArrowRight') c.seek(c.t + (e.shiftKey ? 5000 : 1000));
      else if (e.key === 'ArrowLeft') c.seek(c.t - (e.shiftKey ? 5000 : 1000));
      else if (e.key === ']') c.nudgeSpeed(1);
      else if (e.key === '[') c.nudgeSpeed(-1);
      else if (e.key === 'd') setDiff((d) => !d);
      else if (e.key === 'e') setDrawerOverride((d) => (d === 'open' ? 'peek' : 'open'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- derived layout ------------------------------------------------------
  const compare = scene.phase === 'compare';
  const culpritIdx = state.culprit ? state.indexOf.get(state.culprit.badSha) : undefined;
  const goodIdx = state.culprit ? state.indexOf.get(state.culprit.goodSha) : undefined;

  // Evidence rises with the comparison, then steps back so the phones can
  // reclaim the screen for every loop after the first.
  const sinceCulprit = timeline.culpritAt === undefined ? -1 : t - timeline.culpritAt;
  const autoDrawer: DrawerState =
    scene.phase === 'search' || sinceCulprit < REVEAL_MS * 0.79
      ? 'hidden'
      : sinceCulprit < REVEAL_MS + EVIDENCE_HOLD_MS
        ? 'open'
        : 'peek';
  const drawer: DrawerState = scene.phase === 'search' ? 'hidden' : (drawerOverride ?? autoDrawer);
  const drawerH = drawer === 'hidden' ? 0 : drawer === 'peek' ? DRAWER_PEEK : DRAWER_OPEN;

  const railH = compare ? RAIL_COMPACT : RAIL_SEARCH;
  const controlsH = chrome ? CONTROLS_H : 0;
  const stageH = DESIGN_H - BAR_H - railH - controlsH - (compare ? drawerH : 0);
  /** The comparison is laid out for the peek height and scaled down when the drawer is open. */
  const comparePeekH = DESIGN_H - BAR_H - RAIL_COMPACT - controlsH - DRAWER_PEEK;

  const railRange = useMemo(() => {
    if (state.culprit && goodIdx !== undefined && culpritIdx !== undefined) {
      return [Math.min(goodIdx, culpritIdx), Math.max(goodIdx, culpritIdx)] as [number, number];
    }
    return state.activeRange;
  }, [state.activeRange, state.culprit, goodIdx, culpritIdx]);

  const remaining = remainingCount(state);
  const railLabel = state.culprit
    ? 'first bad commit'
    : state.commits.length
      ? `searching ${remaining} commits`
      : '';

  const goodCommit = goodIdx !== undefined ? state.commits[goodIdx] : undefined;
  const badCommit = culpritIdx !== undefined ? state.commits[culpritIdx] : undefined;
  const goodResult = state.culprit ? state.results.get(state.culprit.goodSha) : undefined;
  const badResult = state.culprit ? state.results.get(state.culprit.badSha) : undefined;
  // Declared after noCaptures so the drawer knows whether it may draw the fixture.

  /**
   * Every result in the stream, regardless of where the playhead is.
   *
   * A candidate that is mid-round has not emitted `commit.completed` yet, so
   * the time-sliced state has no frames for it and the phone would sit empty
   * for the whole round. The frames it eventually produced are the frames it
   * was producing at the time, and they are indexed by the step being replayed,
   * so nothing is shown before the step that captured it.
   */
  const framesBySha = useMemo(() => {
    const out = new Map<string, CommitResult>();
    for (const e of events) if (e.type === 'commit.completed') out.set(e.result.sha, e.result);
    return out;
  }, [events]);

  /**
   * A report with no captured frame anywhere is the fixture or a dry run, and
   * the illustrated store is the intended stand-in. Once any run has captured
   * a real frame, a missing one is a gap and gets said so.
   */
  const noCaptures = useMemo(() => {
    // Frames arriving right now are proof enough that this run captures.
    if (state.liveFrames.size) return false;
    // No results yet is a run that has not finished a candidate, not a fixture.
    // Treating it as one drew the illustrated store on every real run for the
    // minute or so before the first candidate reported.
    if (state.results.size === 0) return false;
    for (const r of state.results.values()) {
      if (r.localPaths?.length || r.screenshots?.length) return false;
    }
    return true;
  }, [state.results, state.liveFrames]);

  const evidence = useMemo(
    () => evidenceFor({ bad: badResult, good: goodResult, synthetic: noCaptures }),
    [badResult, goodResult, noCaptures],
  );

  /**
   * The flow's own step labels, whatever its length. Requiring seven of them
   * meant every flow that was not the seven-step demo silently rendered the
   * demo's labels instead of its own.
   */
  const stepLabels = useMemo(() => {
    const forCulprit = state.culprit ? state.steps.get(state.culprit.goodSha) : undefined;
    const marks = forCulprit?.length ? forCulprit : firstSteps(state.steps);
    if (marks?.length) return marks.map((m) => m.label);
    return FALLBACK_STEPS;
  }, [state.culprit, state.steps]);

  const revealLine = spanned(scene.reveal, 0.58, 0.88);
  const parallelCount = parallel === true ? 4 : Number(parallel) || 0;

  return (
    <MediaContext.Provider
      value={{ allowRemote: allowRemoteMedia, frames: frameData, synthetic: noCaptures }}
    >
      {/* The scaled canvas needs a layout box the size it actually renders at.
          `transform` does not resize the box, so a 1440x900 element scaled to
          0.8 still reserves 1440x900 and the page centres and clips against
          the wrong rectangle. Sizing the wrapper to the scaled dimensions and
          scaling from the top left keeps layout and pixels agreeing. */}
      <div
        className="fit"
        style={{ width: DESIGN_W * scale, height: DESIGN_H * scale }}
      >
        <div className="fit-inner" style={{ transform: `scale(${scale})` }}>
        <div
          className="app"
          data-phase={scene.phase}
          data-chrome={chrome}
          style={{ width: DESIGN_W, height: DESIGN_H }}
        >
          <CommandBar
            meta={state.meta}
            round={state.round}
            remaining={remaining}
            done={!!state.culprit}
            live={live}
          />

          <div className="rail-wrap" style={{ height: railH }}>
            <CommitRail
              commits={state.commits}
              states={state.states}
              range={railRange}
              width={DESIGN_W - RAIL_PAD * 2}
              reveal={scene.phase === 'search' ? 0 : scene.reveal}
              compact={compare}
              culpritIndex={culpritIdx}
              goodIndex={goodIdx}
              candidateSha={state.running?.sha ?? state.candidateSha}
              label={railLabel}
              scale={scale}
            />
          </div>

          <main className="stage" style={{ height: stageH }}>
            {compare && goodCommit && badCommit ? (
              <FinalComparison
                goodCommit={goodCommit}
                badCommit={badCommit}
                goodResult={goodResult}
                badResult={badResult}
                pos={scene.comparePos}
                slowmo={scene.slowmo}
                stepLabels={stepLabels}
                height={comparePeekH}
                fit={Math.min(1, stageH / comparePeekH)}
                diff={diff}
                onToggleDiff={() => setDiff((d) => !d)}
                onScrubStep={(step) => {
                  const base = (timeline.culpritAt ?? 0) + REVEAL_MS;
                  clock.seek(base + (step - 1) * 1000);
                  clock.setPlaying(false);
                }}
              />
            ) : (
              <DeviceStage
                state={state}
                height={stageH}
                parallel={parallelCount}
                live={live}
                framesBySha={framesBySha}
              />
            )}
          </main>

          {drawer !== 'hidden' && (
            <EvidenceDrawer
              state={drawer}
              tab={tab}
              onTab={setTab}
              onToggle={() => setDrawerOverride(drawer === 'open' ? 'peek' : 'open')}
              diagnosis={state.culprit?.diagnosis}
              evidence={evidence}
              goodCommit={goodCommit}
              badCommit={badCommit}
              goodFrame={lastFrame(captured(goodResult), allowRemoteMedia, frameData)}
              badFrame={lastFrame(captured(badResult), allowRemoteMedia, frameData)}
              height={drawerH}
            />
          )}

          <Connector
            from="culprit-node"
            to="bad-phone"
            active={scene.phase === 'reveal' && revealLine > 0}
            progress={revealLine}
            scale={scale}
          />
          <Connector
            from="cmp-fail"
            to="evidence-focus"
            active={compare && drawer === 'open'}
            scale={scale}
            stopAtDrawer
          />

          {chrome && (
            <ReplayControls
              clock={clock}
              timeline={timeline}
              live={live}
              following={following}
              onFollow={() => setFollowing((f) => !f)}
            />
          )}
        </div>
        </div>
      </div>
    </MediaContext.Provider>
  );
}

export default BisectReport;
