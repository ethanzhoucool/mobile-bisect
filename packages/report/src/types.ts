/**
 * Re-declaration of the `@mobile-bisect/core` contract.
 *
 * The browser bundle must not reach across package boundaries at build time
 * (the static report has to build standalone), so the shapes it consumes are
 * mirrored here. `packages/core/src/types.ts` remains the source of truth -
 * this file is type-only and must stay structurally identical.
 */

export type CommitState =
  | 'untested'
  | 'scheduled'
  | 'running'
  | 'good'
  | 'bad'
  | 'skipped'
  | 'inconclusive';

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  index: number;
}

export interface Artifacts {
  videoUrl?: string;
  screenshots?: string[];
  logsUrl?: string;
  networkUrl?: string;
  localPaths?: string[];
}

export interface CommitResult extends Artifacts {
  sha: string;
  subject: string;
  author: string;
  state: CommitState;
  runId?: string;
  assertion?: string;
  assertionPassed?: boolean;
  reason?: string;
  durationMs?: number;
  attempt?: number;
}

export interface BisectMeta {
  runId: string;
  command: string;
  flowName: string;
  goodRef: string;
  badRef: string;
  expect: string;
  totalCommits: number;
  /** How many steps the flow has, known before the first candidate runs. */
  flowSteps?: number;
  plannedRounds: number;
}

export type ActiveRange = [number, number];

export type BisectEvent =
  | { type: 'search.started'; at: string; meta: BisectMeta; commits: CommitSummary[] }
  | {
      type: 'round.started';
      at: string;
      round: number;
      activeRange: ActiveRange;
      candidateSha: string;
    }
  | { type: 'commit.running'; at: string; sha: string; streamUrl?: string; sessionId?: string }
  | { type: 'flow.step'; at: string; sha: string; index: number; total: number; label: string }
  | { type: 'flow.frame'; at: string; sha: string; ordinal: number; path: string }
  | { type: 'commit.completed'; at: string; result: CommitResult }
  | {
      type: 'range.narrowed';
      at: string;
      round: number;
      activeRange: ActiveRange;
      remaining: number;
    }
  | { type: 'culprit.found'; at: string; goodSha: string; badSha: string; diagnosis?: string }
  | { type: 'report.ready'; at: string; reportPath: string }
  | { type: 'search.failed'; at: string; message: string };

export type BisectEventType = BisectEvent['type'];
