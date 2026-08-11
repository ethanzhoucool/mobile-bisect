import { boundaryFor, recentResults, type ViewState } from '../state/model.ts';
import type { CommitResult } from '../types.ts';
import { clamp } from '../lib/util.ts';
import { DeviceCard } from './DeviceCard.tsx';

// header/footer blocks plus the two 14px column gaps
const HEAD = 70;
const FOOT = 156;

export interface DeviceStageProps {
  state: ViewState;
  height: number;
  parallel: number;
  /** Live run: the running candidate may embed its device session. */
  live?: boolean;
  /** Every result in the stream, so a mid-round candidate can still replay. */
  framesBySha?: Map<string, CommitResult>;
}

/**
 * Local copies before presigned URLs: they never expire, and their filenames
 * carry the step number the playhead uses to pick a frame.
 */
/** The flow's step count, from whichever candidate first reported it. */
function stepTotal(state: ViewState): number | undefined {
  for (const marks of state.steps.values()) {
    const total = marks[marks.length - 1]?.total;
    if (total) return total;
  }
  // Before the first step reports in, the flow's own length is the only honest
  // answer; without it the phone falls back to the demo fixture's seven.
  return state.meta?.flowSteps;
}

function framesOf(result?: { localPaths?: string[]; screenshots?: string[] }): string[] | undefined {
  return result?.localPaths?.length ? result.localPaths : result?.screenshots;
}

export function DeviceStage({ state, height, parallel, live, framesBySha }: DeviceStageProps) {
  const candidateSha = state.running?.sha ?? state.candidateSha;
  const candidate = candidateSha ? state.commits[state.indexOf.get(candidateSha) ?? -1] : undefined;
  const candidateResult = candidateSha ? state.results.get(candidateSha) : undefined;
  const steps = candidateSha ? state.steps.get(candidateSha) : undefined;
  const step = state.running?.step ?? steps?.[steps.length - 1];
  // Before the first `flow.step` there is no mark to read the length off, so
  // borrow it from any candidate that has already reported one.
  const flowSteps = stepTotal(state);

  const cards: React.ReactNode[] = [];
  const count = parallel > 1 ? parallel : candidateSha && state.completed.length ? 2 : 1;
  const cardWidth = count > 2 ? 306 : 384;
  const phoneWidth = clamp((height - HEAD - FOOT) / 2.06, 150, count > 2 ? 208 : 268);

  if (candidate) {
    const st = candidateResult?.state ?? state.states[candidate.index] ?? 'scheduled';
    cards.push(
      <DeviceCard
        key={candidate.sha}
        role={`round ${state.round} · candidate`}
        roleTone="blue"
        shortSha={candidate.shortSha}
        subject={candidate.subject}
        state={st}
        step={step}
        flowSteps={flowSteps}
        reason={candidateResult?.reason}
        videoUrl={candidateResult?.videoUrl}
        /* Verdict and step come from the playhead; the frames may come from
           the eventual result, since a running candidate has not reported one
           yet and `frameIndexFor` only ever shows the step being replayed. */
        frames={
          framesOf(candidateResult ?? framesBySha?.get(candidateSha ?? '')) ??
          state.liveFrames.get(candidateSha ?? '')
        }
        /* Only the candidate that is running right now, only before it has a
           verdict, and only until its own screens start arriving: a frame the
           run actually captured beats an embedded viewer that brings its own
           toolbar and phone bezel into the middle of ours. */
        liveUrl={
          live && !candidateResult && !state.liveFrames.get(candidateSha ?? '')?.length
            ? state.running?.streamUrl
            : undefined
        }
        phoneWidth={phoneWidth}
        width={cardWidth}
        anchor={st === 'bad' ? 'bad-phone' : undefined}
      />,
    );
  }

  const others =
    parallel > 1
      ? recentResults(state, parallel - 1, candidateSha)
      : [boundaryFor(state, candidateSha)].filter(Boolean);

  for (const r of others) {
    if (!r) continue;
    const c = state.commits[state.indexOf.get(r.sha) ?? -1];
    if (!c) continue;
    const lastStep = state.steps.get(r.sha)?.slice(-1)[0];
    const isCulprit = state.culprit?.badSha === r.sha;
    cards.push(
      <DeviceCard
        key={r.sha}
        role={
          isCulprit
            ? 'first bad'
            : r.state === 'good'
              ? 'last known good'
              : r.state === 'bad'
                ? 'last known bad'
                : `last ${r.state}`
        }
        roleTone={r.state === 'good' ? 'green' : r.state === 'bad' ? 'red' : 'muted'}
        shortSha={c.shortSha}
        subject={c.subject}
        state={r.state}
        step={lastStep}
        flowSteps={flowSteps}
        reason={r.reason}
        videoUrl={r.videoUrl}
        frames={framesOf(r)}
        phoneWidth={phoneWidth}
        width={cardWidth}
        dim
        anchor={r.state === 'bad' ? 'bad-phone' : undefined}
      />,
    );
  }

  return (
    <div className="stage-row" data-count={cards.length}>
      {cards}
    </div>
  );
}
