import { createContext, useContext, useState } from 'react';
import { PhoneFrame } from './PhoneFrame.tsx';
import { OrbitStore, screenForStep, type OrbitScreen } from './OrbitStore.tsx';
import { frameIndexFor } from '../lib/frames.ts';
import type { CommitState } from '../types.ts';

export interface MediaConfig {
  allowRemote: boolean;
  /** originalUrl -> data: URI, populated by renderReport for static reports. */
  frames?: Record<string, string>;
  /**
   * True when the whole report captured no device frames, i.e. the demo
   * fixture or a dry run. Only then may a phone draw the illustrated store.
   */
  synthetic?: boolean;
}

export const MediaContext = createContext<MediaConfig>({ allowRemote: false });

/** Read the fixture flag from context so no call site has to thread it. */
function useSynthetic(): boolean {
  return useContext(MediaContext).synthetic ?? false;
}

/**
 * Remote artifact URLs are ignored unless explicitly allowed: a static report
 * has to open from file:// with no network at all. `renderReport` inlines
 * frames as data: URIs (presigned S3 links expire), and those pass through.
 */
function useMedia(url?: string): string | undefined {
  const { allowRemote, frames } = useContext(MediaContext);
  if (!url) return undefined;
  const inlined = frames?.[url];
  if (inlined) return inlined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return allowRemote ? url : undefined;
  return url;
}

function useFrames(list?: string[]): string[] {
  const { allowRemote, frames } = useContext(MediaContext);
  if (!list?.length) return [];
  return list
    .map((f) => frames?.[f] ?? f)
    .filter((f) => allowRemote || !/^[a-z][a-z0-9+.-]*:\/\//i.test(f));
}

/**
 * Captured step frames cross-faded in place. Every frame is mounted so the
 * swap is a pure opacity change — a 14-frame run still reads as motion rather
 * than a slideshow, and there is no decode hitch mid-playback.
 */
function FrameStrip({
  frames,
  index,
  assert,
  onBroken,
}: {
  frames: string[];
  index: number;
  assert?: 'pass' | 'fail' | null;
  onBroken: (src: string) => void;
}) {
  return (
    <div className="frames" data-assert={assert ?? undefined}>
      {frames.map((src, i) => (
        <img
          key={src + i}
          className="frame"
          src={src}
          alt=""
          data-on={i === index}
          draggable={false}
          onError={() => onBroken(src)}
        />
      ))}
    </div>
  );
}

export function PhoneScreen({
  videoUrl,
  frames,
  pos,
  totalSteps = 7,
  screen,
  assert,
  diff,
}: {
  videoUrl?: string;
  /** Ordered per-step captures; the primary playback path. */
  frames?: string[];
  /** Fractional flow position used to pick the frame. */
  pos?: number;
  totalSteps?: number;
  screen: OrbitScreen;
  assert?: 'pass' | 'fail' | null;
  diff?: boolean;
}) {
  const synthetic = useSynthetic();
  const src = useMedia(videoUrl);
  const all = useFrames(frames);
  const [broken, setBroken] = useState(false);
  // Presigned artifact links expire mid-session; drop what 404s and fall back
  // to the drawn screen rather than showing a broken-image glyph.
  const [dead, setDead] = useState<Set<string>>(() => new Set());
  const strip = all.filter((f) => !dead.has(f));

  // Video is the upgrade path if a runner ever hands us one.
  if (src && !broken) {
    return (
      <video
        className="phone-video"
        src={src}
        autoPlay
        muted
        loop
        playsInline
        onError={() => setBroken(true)}
      />
    );
  }
  if (strip.length) {
    return (
      <>
        <FrameStrip
          frames={strip}
          index={frameIndexFor(pos ?? totalSteps, strip.length, totalSteps, strip)}
          assert={assert}
          onBroken={(f) => setDead((prev) => new Set(prev).add(f))}
        />
        {diff && <DiffOverlay />}
      </>
    );
  }
  // No capture to show. The drawn store is the demo fixture's stand-in, and it
  // is a different app than the one under test — rendering it for a real run
  // would put a screen on the phone that the run never produced.
  if (synthetic) return <OrbitStore screen={screen} assert={assert} diff={diff} />;
  return <NoCapture assert={assert} />;
}

/**
 * What a phone shows when the run captured nothing for this step: the fact,
 * not a stand-in. An invented screen here is worse than an empty one, because
 * it is indistinguishable from evidence.
 */
export function NoCapture({ assert }: { assert?: 'pass' | 'fail' | null }) {
  return (
    <div className="phone-empty" data-assert={assert ?? undefined}>
      <span className="phone-empty-mark" aria-hidden="true" />
      <span className="micro">no frame captured</span>
    </div>
  );
}

/** Semantic region diff — the two runs are the same step index, so the regions line up. */
export function DiffOverlay() {
  return (
    <div className="ob-diff">
      <div className="ob-diff-region" data-kind="missing" style={{ top: '12%', height: '36%' }}>
        <span>confirmation panel missing</span>
      </div>
      <div className="ob-diff-region" data-kind="stuck" style={{ top: '83%', height: '8.5%' }}>
        <span>cta still loading</span>
      </div>
    </div>
  );
}

export type Role = 'candidate' | 'good' | 'bad' | 'other';

const VERDICT_LABEL: Record<string, string> = {
  good: 'good',
  bad: 'bad',
  skipped: 'skipped',
  inconclusive: 'inconclusive',
  running: 'testing',
  scheduled: 'queued',
  untested: 'queued',
};

export interface DeviceCardProps {
  role: string;
  roleTone?: 'blue' | 'green' | 'red' | 'muted';
  shortSha: string;
  subject: string;
  state: CommitState;
  step?: { index: number; total: number; label: string };
  reason?: string;
  videoUrl?: string;
  frames?: string[];
  phoneWidth: number;
  width: number;
  dim?: boolean;
  anchor?: string;
}

export function DeviceCard({
  role,
  roleTone = 'muted',
  shortSha,
  subject,
  state,
  step,
  reason,
  videoUrl,
  frames,
  phoneWidth,
  width,
  dim,
  anchor,
}: DeviceCardProps) {
  const done = state === 'good' || state === 'bad' || state === 'skipped' || state === 'inconclusive';
  const verdict = state === 'good' ? 'pass' : state === 'bad' ? 'fail' : undefined;
  const total = step?.total ?? 7;
  const idx = done ? total : (step?.index ?? 0);
  const screen = screenForStep(done ? 7 : (step?.index ?? 0), verdict);
  const glow = state === 'running' ? 'blue' : state === 'good' ? 'green' : state === 'bad' ? 'red' : 'none';

  return (
    <div
      className="dc"
      style={{ width }}
      data-dim={dim || undefined}
      data-verdict={
        /first bad/i.test(role) ? 'culprit' : /last good/i.test(role) ? 'lastgood' : undefined
      }
    >
      <div className="dc-head">
        <div className="micro" data-tone={roleTone}>
          {role}
        </div>
        <div className="dc-id">
          <span className="mono dc-hash">{shortSha}</span>
          <span className="dc-subject">{subject}</span>
        </div>
      </div>

      <div data-anchor={anchor}>
        <PhoneFrame width={phoneWidth} glow={glow} flipId={`phone:${shortSha}`}>
          <PhoneScreen
            videoUrl={videoUrl}
            frames={frames}
            pos={done ? total : Math.max(0, idx - 0.5)}
            totalSteps={total}
            screen={screen}
            assert={done ? (verdict ?? null) : null}
          />
        </PhoneFrame>
      </div>

      <div className="dc-foot">
        <div className="dc-step">
          <span className="mono dc-step-n">
            {idx} / {total}
          </span>
          <span className="dc-step-label">{done ? (step?.label ?? 'Assert order confirmation') : step?.label ?? 'Starting session'}</span>
        </div>
        <div className="dc-track" data-state={state}>
          {Array.from({ length: total }, (_, i) => (
            <i key={i} data-on={i < idx} data-cur={i === idx - 1 && !done} />
          ))}
        </div>
        <div className="dc-verdict" data-state={state}>
          <span className="dc-chip">{VERDICT_LABEL[state] ?? state}</span>
          {reason && <span className="dc-reason">{reason}</span>}
        </div>
      </div>
    </div>
  );
}
