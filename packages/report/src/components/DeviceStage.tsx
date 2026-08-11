import { boundaryFor, recentResults, type ViewState } from '../state/model.ts';
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
}

/**
 * Local copies before presigned URLs: they never expire, and their filenames
 * carry the step number the playhead uses to pick a frame.
 */
function framesOf(result?: { localPaths?: string[]; screenshots?: string[] }): string[] | undefined {
  return result?.localPaths?.length ? result.localPaths : result?.screenshots;
}

export function DeviceStage({ state, height, parallel, live }: DeviceStageProps) {
  const candidateSha = state.running?.sha ?? state.candidateSha;
  const candidate = candidateSha ? state.commits[state.indexOf.get(candidateSha) ?? -1] : undefined;
  const candidateResult = candidateSha ? state.results.get(candidateSha) : undefined;
  const steps = candidateSha ? state.steps.get(candidateSha) : undefined;
  const step = state.running?.step ?? steps?.[steps.length - 1];

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
        reason={candidateResult?.reason}
        videoUrl={candidateResult?.videoUrl}
        frames={framesOf(candidateResult)}
        /* Only the candidate that is running right now, and only before it has
           a verdict: once classified, its captured frames are the evidence and
           the session is on its way out. */
        liveUrl={live && !candidateResult ? state.running?.streamUrl : undefined}
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
