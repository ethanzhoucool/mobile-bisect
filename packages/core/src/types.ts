/**
 * Shared contract for every mobile-bisect package.
 *
 * This file is the single source of truth. `core` owns the bisection state
 * machine, the runner packages implement the runtime interfaces, the framework
 * adapters implement `adapter.ts`, and `report` renders the event stream.
 * Nothing here may import from another package.
 */

export type Platform = 'ios' | 'android';

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export type CommitState =
  | 'untested'
  | 'scheduled'
  | 'running'
  | 'good'
  | 'bad'
  | 'skipped'
  | 'inconclusive';

/** A commit as enumerated from git, before any testing. */
export interface CommitSummary {
  sha: string;
  /** 7-char abbreviation, precomputed so the UI never has to slice. */
  shortSha: string;
  subject: string;
  author: string;
  /** ISO-8601, author date. */
  authoredAt: string;
  /** 0 = oldest (the `--good` boundary), n-1 = newest (the `--bad` boundary). */
  index: number;
}

export interface Artifacts {
  videoUrl?: string;
  screenshots?: string[];
  logsUrl?: string;
  networkUrl?: string;
  /** Local paths under runs/<id>/artifacts, relative to the run dir. */
  localPaths?: string[];
}

export interface CommitResult extends Artifacts {
  sha: string;
  subject: string;
  author: string;
  state: CommitState;
  runId?: string;
  /** The natural-language assertion that was evaluated. */
  assertion?: string;
  /** Runner's verdict on the assertion, independent of bisect bookkeeping. */
  assertionPassed?: boolean;
  /** Why the runner decided what it decided. Shown in the UI verbatim. */
  reason?: string;
  durationMs?: number;
  /** 1 on first attempt; incremented when an inconclusive run is retried. */
  attempt?: number;
}

// ---------------------------------------------------------------------------
// Flow definition (the YAML the user points `--flow` at)
// ---------------------------------------------------------------------------

export interface FlowStep {
  /** Human label rendered under the phone, e.g. `Tap "Place order"`. */
  label: string;
  /** Revyl-native step body. Passed through to the runner untouched. */
  [key: string]: unknown;
}

export interface FlowDefinition {
  name: string;
  appId?: string;
  steps: FlowStep[];
  /** Natural-language assertion; `--expect` overrides this. */
  expect?: string;
}

// ---------------------------------------------------------------------------
// Runtime interfaces — implemented by revyl-runner, faked in tests
// ---------------------------------------------------------------------------

export interface StartSessionInput {
  platform: Platform;
  deviceModel?: string;
  osVersion?: string;
  /** Existing session to reuse instead of starting a new one. */
  sessionId?: string;
}

export interface Session {
  sessionId: string;
  deviceModel: string;
  osVersion: string;
  /** Live view the report embeds while the run is active. */
  streamUrl?: string;
}

export interface LaunchInput {
  sessionId: string;
  /** Where the candidate JS bundle is being served or exported from. */
  bundleUrl?: string;
  buildId?: string;
  /**
   * A locally built artifact for this candidate (.app.zip / .apk / .ipa). Set
   * by adapters that compile a binary per commit; the runner uploads it and
   * installs the result. Ignored when `buildId` is already known.
   */
  appPath?: string;
  /** Launched after install when there is no bundle URL to navigate to. */
  bundleId?: string;
  /** Reset app data before launch so every candidate starts identically. */
  resetState?: boolean;
}

export interface UploadBuildInput {
  /** Local path to the artifact. */
  appPath: string;
  platform: Platform;
  /** Version label for the uploaded build; the candidate SHA is a good one. */
  version?: string;
}

export interface UploadedBuild {
  /** What `installOrLaunch` and `startSession` take as `buildId`. */
  buildId: string;
  version?: string;
}

export interface RunFlowInput {
  sessionId: string;
  flow: FlowDefinition;
  assertion: string;
  /** Emitted per step so the report can render progress live. */
  onStep?: (index: number, label: string) => void;
  timeoutMs?: number;
}

export type RunVerdict = 'pass' | 'fail' | 'inconclusive';

export interface RunResult {
  runId: string;
  verdict: RunVerdict;
  /** One sentence explaining the verdict. Rendered under the device. */
  reason: string;
  durationMs: number;
  stepsCompleted: number;
}

export interface MobileRuntimeRunner {
  startSession(input: StartSessionInput): Promise<Session>;
  installOrLaunch(input: LaunchInput): Promise<void>;
  runFlow(input: RunFlowInput): Promise<RunResult>;
  collectArtifacts(runId: string): Promise<Artifacts>;
  stopSession(sessionId: string): Promise<void>;
  /**
   * Optional: only adapters that compile a binary per commit need it. A runner
   * without this can still serve every bundle-swapping framework.
   */
  uploadBuild?(input: UploadBuildInput): Promise<UploadedBuild>;
}

// ---------------------------------------------------------------------------
// Event stream — append-only, persisted to events.jsonl, consumed by report
// ---------------------------------------------------------------------------

export interface BisectMeta {
  runId: string;
  command: string;
  flowName: string;
  goodRef: string;
  badRef: string;
  expect: string;
  totalCommits: number;
  /** ceil(log2(n)) — the round count shown in the command bar. */
  plannedRounds: number;
}

/**
 * `activeRange` is an inclusive pair of indices into the `commits` array from
 * `search.started`. The report uses it to drive the collapsing rail.
 */
export type ActiveRange = [number, number];

export type BisectEvent =
  | { type: 'search.started'; at: string; meta: BisectMeta; commits: CommitSummary[] }
  | { type: 'round.started'; at: string; round: number; activeRange: ActiveRange; candidateSha: string }
  | { type: 'commit.running'; at: string; sha: string; streamUrl?: string; sessionId?: string }
  | { type: 'flow.step'; at: string; sha: string; index: number; total: number; label: string }
  | { type: 'commit.completed'; at: string; result: CommitResult }
  | { type: 'range.narrowed'; at: string; round: number; activeRange: ActiveRange; remaining: number }
  | { type: 'culprit.found'; at: string; goodSha: string; badSha: string; diagnosis?: string }
  | { type: 'report.ready'; at: string; reportPath: string }
  | { type: 'search.failed'; at: string; message: string };

export type BisectEventType = BisectEvent['type'];

// ---------------------------------------------------------------------------
// Persisted run state (state.json) — enables `--resume`
// ---------------------------------------------------------------------------

export interface BisectState {
  version: 1;
  meta: BisectMeta;
  commits: CommitSummary[];
  /** sha -> result, for every commit that has been classified. */
  results: Record<string, CommitResult>;
  activeRange: ActiveRange;
  round: number;
  culprit?: { goodSha: string; badSha: string; diagnosis?: string };
  startedAt: string;
  finishedAt?: string;
}
