import type {
  ActiveRange,
  BisectEvent,
  BisectMeta,
  CommitResult,
  CommitState,
  CommitSummary,
} from '../types.ts';

export interface FlowStepMark {
  index: number;
  total: number;
  label: string;
  at: number;
}

export interface RunningState {
  sha: string;
  streamUrl?: string;
  sessionId?: string;
  step?: FlowStepMark;
}

export interface Culprit {
  goodSha: string;
  badSha: string;
  diagnosis?: string;
}

export interface ViewState {
  meta?: BisectMeta;
  commits: CommitSummary[];
  /** sha -> index, built once from search.started. */
  indexOf: Map<string, number>;
  /** Per-commit state, indexed like `commits`. */
  states: CommitState[];
  results: Map<string, CommitResult>;
  /** Steps seen so far for each commit, in order. */
  steps: Map<string, FlowStepMark[]>;
  round: number;
  activeRange: ActiveRange;
  candidateSha?: string;
  running?: RunningState;
  /** shas in completion order, drives the "closest known boundary" card. */
  completed: string[];
  culprit?: Culprit;
  culpritAt?: number;
  failure?: string;
  reportPath?: string;
  /** Virtual ms of the newest event folded in. */
  clock: number;
}

const EMPTY_RANGE: ActiveRange = [0, 0];

export function emptyState(): ViewState {
  return {
    commits: [],
    indexOf: new Map(),
    states: [],
    results: new Map(),
    steps: new Map(),
    round: 0,
    activeRange: EMPTY_RANGE,
    completed: [],
    clock: 0,
  };
}

/**
 * Folds one event in place. Cheap enough to replay the whole stream every frame
 * (a 6-round run is <100 events), which is what makes scrubbing exact rather
 * than approximate, there is no separate "rewind" path that can drift.
 */
export function applyEvent(s: ViewState, ev: BisectEvent, at: number): void {
  s.clock = at;
  switch (ev.type) {
    case 'search.started': {
      s.meta = ev.meta;
      s.commits = ev.commits;
      s.indexOf = new Map(ev.commits.map((c) => [c.sha, c.index]));
      s.states = ev.commits.map(() => 'untested');
      s.activeRange = [0, Math.max(0, ev.commits.length - 1)];
      break;
    }
    case 'round.started': {
      s.round = ev.round;
      s.activeRange = ev.activeRange;
      s.candidateSha = ev.candidateSha;
      const i = s.indexOf.get(ev.candidateSha);
      if (i !== undefined && s.states[i] === 'untested') s.states[i] = 'scheduled';
      break;
    }
    case 'commit.running': {
      s.running = { sha: ev.sha, streamUrl: ev.streamUrl, sessionId: ev.sessionId };
      const i = s.indexOf.get(ev.sha);
      if (i !== undefined) s.states[i] = 'running';
      break;
    }
    case 'flow.step': {
      const mark: FlowStepMark = { index: ev.index, total: ev.total, label: ev.label, at };
      const list = s.steps.get(ev.sha) ?? [];
      if (!list.some((m) => m.index === mark.index)) list.push(mark);
      s.steps.set(ev.sha, list);
      if (s.running?.sha === ev.sha) s.running = { ...s.running, step: mark };
      break;
    }
    case 'commit.completed': {
      const r = ev.result;
      s.results.set(r.sha, r);
      const i = s.indexOf.get(r.sha);
      if (i !== undefined) s.states[i] = r.state;
      if (!s.completed.includes(r.sha)) s.completed.push(r.sha);
      if (s.running?.sha === r.sha) s.running = undefined;
      break;
    }
    case 'range.narrowed': {
      s.round = ev.round;
      s.activeRange = ev.activeRange;
      break;
    }
    case 'culprit.found': {
      s.culprit = { goodSha: ev.goodSha, badSha: ev.badSha, diagnosis: ev.diagnosis };
      s.culpritAt = at;
      break;
    }
    case 'report.ready': {
      s.reportPath = ev.reportPath;
      break;
    }
    case 'search.failed': {
      s.failure = ev.message;
      break;
    }
  }
}

/** Number of commits still in play. */
export function remainingCount(s: ViewState): number {
  if (!s.commits.length) return 0;
  const [a, b] = s.activeRange;
  return Math.max(0, b - a + 1);
}

/**
 * The boundary the candidate is being compared against.
 *
 * Once the candidate has a verdict the useful comparison is against the
 * nearest commit that went the *other* way, that pair is the one the search
 * is closing in on. Before then, fall back to the nearest result of any kind.
 */
export function boundaryFor(s: ViewState, candidateSha?: string): CommitResult | undefined {
  if (!candidateSha) return undefined;
  const ci = s.indexOf.get(candidateSha);
  if (ci === undefined) return undefined;
  const own = s.results.get(candidateSha)?.state;
  const opposite = own === 'good' ? 'bad' : own === 'bad' ? 'good' : undefined;

  const pick = (want?: CommitState) => {
    let best: CommitResult | undefined;
    let bestDist = Infinity;
    for (let k = s.completed.length - 1; k >= 0; k--) {
      const sha = s.completed[k];
      if (sha === candidateSha) continue;
      const r = s.results.get(sha);
      const i = s.indexOf.get(sha);
      if (!r || i === undefined) continue;
      if (want && r.state !== want) continue;
      const d = Math.abs(i - ci);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    return best;
  };

  return (opposite && pick(opposite)) ?? pick();
}

/** Most recent completed results, newest first (4-up parallel mode). */
export function recentResults(s: ViewState, n: number, exclude?: string): CommitResult[] {
  const out: CommitResult[] = [];
  for (let i = s.completed.length - 1; i >= 0 && out.length < n; i--) {
    const sha = s.completed[i];
    if (sha === exclude) continue;
    const r = s.results.get(sha);
    if (r) out.push(r);
  }
  return out;
}
