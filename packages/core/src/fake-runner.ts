/**
 * A `MobileRuntimeRunner` that needs no cloud, no build, and no network.
 *
 * Every commit at or after the culprit fails; everything before it passes. This
 * is what makes `expo-bisect --demo` runnable end-to-end, and what the state
 * machine's tests bisect against.
 */

import type {
  Artifacts,
  CommitSummary,
  LaunchInput,
  MobileRuntimeRunner,
  RunFlowInput,
  RunResult,
  RunVerdict,
  Session,
  StartSessionInput,
} from './types.js';

export interface FakeRunnerReasons {
  pass?: string;
  fail?: string;
  inconclusive?: string;
}

export interface FakeRunnerOptions {
  /** First bad commit. This one and every later commit verdict `fail`. */
  culpritSha: string;
  /** The same oldest-first list the Bisector was constructed with. */
  commits: CommitSummary[];
  /** Wall-clock pause between `onStep` callbacks. Default 0 (tests stay fast). */
  stepDelayMs?: number;
  /** Returns `inconclusive` on its first attempt, then its true verdict. */
  flakySha?: string;
  /** Override the generated copy — demos use this to pin exact reason strings. */
  reasons?: FakeRunnerReasons;
}

const ARTIFACT_BASE = 'https://artifacts.revyl.ai/demo';
const STREAM_BASE = 'https://stream.revyl.ai/demo';

export class FakeRunner implements MobileRuntimeRunner {
  private readonly commits: CommitSummary[];
  private readonly byShaOrShort = new Map<string, CommitSummary>();
  private readonly culpritIndex: number;
  private readonly stepDelayMs: number;
  private readonly flakySha?: string;
  private readonly reasons: FakeRunnerReasons;

  /** sessionId -> sha under test. */
  private readonly bindings = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  private pendingSha: string | null = null;
  private sessionSeq = 0;

  constructor(opts: FakeRunnerOptions) {
    if (!opts.commits?.length) throw new Error('FakeRunner needs a non-empty commits list');
    this.commits = opts.commits;
    for (const c of opts.commits) {
      this.byShaOrShort.set(c.sha, c);
      this.byShaOrShort.set(c.shortSha, c);
    }
    const culprit = this.byShaOrShort.get(opts.culpritSha);
    if (!culprit) throw new Error(`culpritSha ${opts.culpritSha} is not in the commits list`);
    this.culpritIndex = culprit.index;
    this.stepDelayMs = opts.stepDelayMs ?? 0;
    if (opts.flakySha !== undefined) this.flakySha = this.resolve(opts.flakySha).sha;
    this.reasons = opts.reasons ?? {};
  }

  /** Bind the next session to this commit. Call before `startSession`. */
  setCandidate(sha: string): void {
    this.pendingSha = this.resolve(sha).sha;
  }

  /** The verdict this runner will produce for `sha` on its next attempt. */
  verdictFor(sha: string): RunVerdict {
    const c = this.resolve(sha);
    const attempt = (this.attempts.get(c.sha) ?? 0) + 1;
    if (this.flakySha === c.sha && attempt === 1) return 'inconclusive';
    return c.index >= this.culpritIndex ? 'fail' : 'pass';
  }

  async startSession(input: StartSessionInput): Promise<Session> {
    if (input.sessionId && this.bindings.has(input.sessionId)) {
      const sha = this.bindings.get(input.sessionId)!;
      return this.session(input, input.sessionId, this.resolve(sha));
    }
    const c = this.pendingSha ? this.resolve(this.pendingSha) : null;
    const id = input.sessionId ?? (c ? `sess_${c.shortSha}` : `sess_${++this.sessionSeq}`);
    if (c) this.bindings.set(id, c.sha);
    return this.session(input, id, c);
  }

  async installOrLaunch(input: LaunchInput): Promise<void> {
    const inferred = this.infer(input.buildId) ?? this.infer(input.bundleUrl);
    if (inferred) this.bindings.set(input.sessionId, inferred.sha);
    if (!this.bindings.has(input.sessionId)) {
      if (!this.pendingSha) {
        throw new Error(
          `FakeRunner cannot tell which commit session ${input.sessionId} is running; ` +
            'pass the sha as buildId/bundleUrl or call setCandidate(sha) first',
        );
      }
      this.bindings.set(input.sessionId, this.pendingSha);
    }
    await sleep(this.stepDelayMs);
  }

  async runFlow(input: RunFlowInput): Promise<RunResult> {
    const sha = this.bindings.get(input.sessionId);
    if (!sha) throw new Error(`unknown session ${input.sessionId}; call startSession first`);
    const c = this.resolve(sha);
    const attempt = (this.attempts.get(c.sha) ?? 0) + 1;
    this.attempts.set(c.sha, attempt);

    const steps = input.flow.steps ?? [];
    const total = steps.length;
    const verdict: RunVerdict =
      this.flakySha === c.sha && attempt === 1
        ? 'inconclusive'
        : c.index >= this.culpritIndex
          ? 'fail'
          : 'pass';

    // An inconclusive run dies partway; pass/fail both walk the whole flow —
    // a broken build still taps every button, it just never lands.
    const dropAt = Math.max(1, Math.ceil(total / 2));
    const stepsCompleted = verdict === 'inconclusive' ? Math.min(dropAt, total) : total;
    for (let i = 0; i < stepsCompleted; i++) {
      input.onStep?.(i + 1, steps[i]!.label);
      if (this.stepDelayMs > 0) await sleep(this.stepDelayMs);
    }

    return {
      runId: `run_${c.shortSha}`,
      verdict,
      reason: this.reasonFor(verdict, input, stepsCompleted, total),
      durationMs:
        verdict === 'inconclusive' ? 18_000 + c.index * 97 : 42_000 + c.index * 137,
      stepsCompleted,
    };
  }

  async collectArtifacts(runId: string): Promise<Artifacts> {
    const short = runId.startsWith('run_') ? runId.slice(4) : runId;
    const c = this.byShaOrShort.get(short);
    const key = c ? c.shortSha : short;
    return {
      videoUrl: `${ARTIFACT_BASE}/${key}/run.mp4`,
      screenshots: [`${ARTIFACT_BASE}/${key}/step-6.png`, `${ARTIFACT_BASE}/${key}/step-7.png`],
      logsUrl: `${ARTIFACT_BASE}/${key}/logs.json`,
      networkUrl: `${ARTIFACT_BASE}/${key}/network.har`,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    this.bindings.delete(sessionId);
    if (this.pendingSha) this.pendingSha = null;
  }

  // -------------------------------------------------------------------------

  private session(input: StartSessionInput, id: string, c: CommitSummary | null): Session {
    return {
      sessionId: id,
      deviceModel: input.deviceModel ?? (input.platform === 'android' ? 'Pixel 7' : 'iPhone 15 Pro'),
      osVersion: input.osVersion ?? (input.platform === 'android' ? '14' : '17.5'),
      streamUrl: `${STREAM_BASE}/${c ? c.shortSha : id}`,
    };
  }

  private reasonFor(
    verdict: RunVerdict,
    input: RunFlowInput,
    stepsCompleted: number,
    total: number,
  ): string {
    const steps = input.flow.steps ?? [];
    const lastAction =
      [...steps].reverse().find((s) => !/^(assert|expect|verify)\b/i.test(s.label))?.label ??
      steps[steps.length - 1]?.label ??
      'the final step';
    if (verdict === 'pass') {
      return (
        this.reasons.pass ??
        `Flow completed in ${total} steps. Assertion held: ${input.assertion} Confirmed 1.2s after "${lastAction}".`
      );
    }
    if (verdict === 'fail') {
      return (
        this.reasons.fail ??
        `Flow completed in ${total} steps but the assertion failed: ${input.assertion} No state change in the 8.0s after "${lastAction}".`
      );
    }
    return (
      this.reasons.inconclusive ??
      `Device session dropped at step ${stepsCompleted} of ${total} ("${steps[stepsCompleted - 1]?.label ?? 'unknown'}"). No verdict — the flow never reached the assertion.`
    );
  }

  private resolve(shaish: string): CommitSummary {
    const c = this.byShaOrShort.get(shaish);
    if (!c) throw new Error(`${shaish} is not in the commits list`);
    return c;
  }

  /** Pull a commit out of a build id or bundle url, full sha first. */
  private infer(hint?: string): CommitSummary | null {
    if (!hint) return null;
    const direct = this.byShaOrShort.get(hint);
    if (direct) return direct;
    for (const c of this.commits) if (hint.includes(c.sha)) return c;
    for (const c of this.commits) if (hint.includes(c.shortSha)) return c;
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
