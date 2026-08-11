/**
 * The bisection state machine.
 *
 * Binary search over the *unknown interior* of the commit list: index 0 is the
 * known-good boundary and index n-1 the known-bad boundary, so only [1, n-2] is
 * ever tested. When `lo > hi` the first bad commit is `commits[lo]`.
 */

import type {
  ActiveRange,
  BisectEvent,
  BisectMeta,
  BisectState,
  CommitResult,
  CommitSummary,
} from './types.js';

export class BisectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BisectError';
  }
}

export interface BisectorOptions {
  /** Oldest-first; index 0 = known good boundary, last = known bad boundary. */
  commits: CommitSummary[];
  meta: BisectMeta;
  /** Called synchronously for every event. */
  emit: (e: BisectEvent) => void;
  /** Injectable clock, for deterministic tests. Defaults to wall clock. */
  now?: () => string;
}

const RESOLVED = new Set(['good', 'bad', 'skipped']);

export class Bisector {
  private readonly commits: CommitSummary[];
  private readonly meta: BisectMeta;
  private readonly emitFn: (e: BisectEvent) => void;
  private readonly now: () => string;

  private lo: number;
  private hi: number;
  private roundNo = 0;
  private activeSha: string | null = null;
  private results: Record<string, CommitResult> = {};
  private attempts: Record<string, number> = {};
  private startedAt: string;
  private finishedAt?: string;
  private culpritPair?: { goodSha: string; badSha: string };
  private diagnosis?: string;
  private failed = false;
  private indexBySha = new Map<string, number>();

  constructor(opts: BisectorOptions) {
    if (!opts.commits || opts.commits.length < 2) {
      throw new BisectError(
        `bisect needs at least 2 commits (a good boundary and a bad boundary); got ${opts.commits?.length ?? 0}`,
      );
    }
    this.commits = opts.commits;
    this.meta = opts.meta;
    this.emitFn = opts.emit;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.commits.forEach((c, i) => this.indexBySha.set(c.sha, i));
    this.lo = 1;
    this.hi = this.commits.length - 2;
    this.startedAt = this.now();

    this.emitFn({
      type: 'search.started',
      at: this.startedAt,
      meta: this.meta,
      commits: this.commits,
    });
    this.settleIfDone();
  }

  /**
   * Rebuild a Bisector from persisted state by replaying the recorded results.
   * Deterministic, so a resumed run picks up on exactly the round and range it
   * left off at. Emits nothing, the events for replayed rounds already exist.
   */
  static resume(state: BisectState, emit: (e: BisectEvent) => void): Bisector {
    const b = Object.create(Bisector.prototype) as Bisector;
    const self = b as unknown as {
      commits: CommitSummary[];
      meta: BisectMeta;
      emitFn: (e: BisectEvent) => void;
      now: () => string;
      lo: number;
      hi: number;
      roundNo: number;
      activeSha: string | null;
      results: Record<string, CommitResult>;
      attempts: Record<string, number>;
      startedAt: string;
      finishedAt?: string;
      culpritPair?: { goodSha: string; badSha: string };
      diagnosis?: string;
      failed: boolean;
      indexBySha: Map<string, number>;
    };
    if (!state.commits || state.commits.length < 2) {
      throw new BisectError('cannot resume: persisted state has fewer than 2 commits');
    }
    self.commits = state.commits;
    self.meta = state.meta;
    self.emitFn = emit;
    self.now = () => new Date().toISOString();
    self.results = { ...state.results };
    self.attempts = {};
    self.startedAt = state.startedAt;
    self.finishedAt = state.finishedAt;
    self.culpritPair = undefined;
    self.diagnosis = state.culprit?.diagnosis;
    self.failed = false;
    self.activeSha = null;
    self.indexBySha = new Map(state.commits.map((c, i) => [c.sha, i]));
    self.lo = 1;
    self.hi = state.commits.length - 2;
    self.roundNo = 0;
    for (const [sha, r] of Object.entries(self.results)) {
      self.attempts[sha] = r.attempt ?? 1;
    }
    b.replay(state.round ?? 0);
    return b;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get state(): BisectState {
    const s: BisectState = {
      version: 1,
      meta: this.meta,
      commits: this.commits,
      results: this.results,
      activeRange: this.activeRange(),
      round: this.roundNo,
      startedAt: this.startedAt,
    };
    if (this.culpritPair) s.culprit = { ...this.culpritPair, diagnosis: this.diagnosis };
    if (this.finishedAt) s.finishedAt = this.finishedAt;
    return s;
  }

  get culprit(): { goodSha: string; badSha: string } | undefined {
    return this.culpritPair;
  }

  get isComplete(): boolean {
    return this.culpritPair !== undefined || this.failed;
  }

  /** Number of times `record()` has been called for `sha`. */
  attemptsFor(sha: string): number {
    return this.attempts[sha] ?? 0;
  }

  /** The candidate currently awaiting a `record()`, if any. */
  get activeCandidate(): CommitSummary | null {
    if (this.activeSha === null) return null;
    return this.commits[this.indexBySha.get(this.activeSha)!] ?? null;
  }

  /**
   * Pick the next commit to test. Returns null once the search is over -
   * either resolved (see `culprit`) or failed (every candidate skipped).
   */
  nextCandidate(): CommitSummary | null {
    if (this.isComplete) return null;
    // A pending candidate is handed back rather than re-picked, so an
    // inconclusive attempt retries the same commit instead of moving on.
    if (this.activeSha !== null) return this.activeCandidate;

    const mid = this.pick();
    if (mid === null) {
      this.fail(
        `every commit in range [${this.lo}, ${this.hi}] was skipped; cannot narrow further`,
      );
      return null;
    }

    const c = this.commits[mid]!;
    this.roundNo += 1;
    this.activeSha = c.sha;
    this.emitFn({
      type: 'round.started',
      at: this.now(),
      round: this.roundNo,
      activeRange: [this.lo, this.hi],
      candidateSha: c.sha,
    });
    return c;
  }

  markRunning(sha: string, info?: { streamUrl?: string; sessionId?: string }): void {
    this.assertActive(sha, 'markRunning');
    this.emitFn({
      type: 'commit.running',
      at: this.now(),
      sha,
      ...(info?.streamUrl !== undefined ? { streamUrl: info.streamUrl } : {}),
      ...(info?.sessionId !== undefined ? { sessionId: info.sessionId } : {}),
    });
  }

  step(sha: string, index: number, total: number, label: string): void {
    this.assertActive(sha, 'step');
    this.emitFn({ type: 'flow.step', at: this.now(), sha, index, total, label });
  }

  /**
   * Classify the active candidate. `inconclusive` records the attempt but does
   * not narrow the range, the caller retries (see RetryPolicy) and then
   * downgrades to `skipped`.
   */
  record(result: CommitResult): void {
    if (this.isComplete) {
      throw new BisectError(`cannot record ${short(result.sha)}: the search is already complete`);
    }
    this.assertActive(result.sha, 'record');

    const attempt = result.attempt ?? (this.attempts[result.sha] ?? 0) + 1;
    this.attempts[result.sha] = attempt;
    const stored: CommitResult = { ...result, attempt };
    this.results[result.sha] = stored;
    this.emitFn({ type: 'commit.completed', at: this.now(), result: stored });

    if (stored.state === 'inconclusive') return; // range untouched; candidate stays active

    if (!RESOLVED.has(stored.state)) {
      throw new BisectError(
        `record() expects state good | bad | skipped | inconclusive, got "${stored.state}"`,
      );
    }

    const mid = this.indexBySha.get(result.sha)!;
    this.activeSha = null;
    if (stored.state === 'good') this.lo = mid + 1;
    else if (stored.state === 'bad') this.hi = mid - 1;
    // 'skipped' leaves the range alone; pick() routes around it next round.

    const [rlo, rhi] = this.activeRange();
    this.emitFn({
      type: 'range.narrowed',
      at: this.now(),
      round: this.roundNo,
      activeRange: [rlo, rhi],
      remaining: Math.max(0, this.hi - this.lo + 1),
    });

    this.settleIfDone();
  }

  /** Attach the diagnostic sentence produced by `diagnose()` to the state. */
  setDiagnosis(diagnosis: string): void {
    this.diagnosis = diagnosis;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Display range: clamped so a finished search never reports an inverted pair. */
  private activeRange(): ActiveRange {
    return [this.lo, Math.max(this.lo, this.hi)];
  }

  /**
   * git-bisect-skip behavior: prefer the midpoint, otherwise walk outward
   * mid-1, mid+1, mid-2, mid+2 … staying inside [lo, hi].
   */
  private pick(): number | null {
    if (this.lo > this.hi) return null;
    const mid = Math.floor((this.lo + this.hi) / 2);
    if (!this.isSkipped(mid)) return mid;
    const span = this.hi - this.lo + 1;
    for (let d = 1; d <= span; d++) {
      for (const cand of [mid - d, mid + d]) {
        if (cand < this.lo || cand > this.hi) continue;
        if (!this.isSkipped(cand)) return cand;
      }
    }
    return null;
  }

  private isSkipped(i: number): boolean {
    const c = this.commits[i];
    return c ? this.results[c.sha]?.state === 'skipped' : true;
  }

  private settleIfDone(): void {
    if (this.isComplete) return;
    if (this.lo <= this.hi) {
      // Range still has room, but it may be entirely skipped.
      if (this.pick() === null) {
        this.fail(`every commit in range [${this.lo}, ${this.hi}] was skipped; cannot narrow further`);
      }
      return;
    }
    const bad = this.commits[this.lo];
    const good = this.commits[this.lo - 1];
    if (!bad || !good) {
      this.fail(`bisect ended outside the commit list (lo=${this.lo}); cannot name a culprit`);
      return;
    }
    this.culpritPair = { goodSha: good.sha, badSha: bad.sha };
    this.finishedAt = this.now();
    this.emitFn({
      type: 'culprit.found',
      at: this.finishedAt,
      goodSha: good.sha,
      badSha: bad.sha,
      ...(this.diagnosis !== undefined ? { diagnosis: this.diagnosis } : {}),
    });
  }

  private fail(message: string): void {
    this.failed = true;
    this.activeSha = null;
    this.finishedAt = this.now();
    this.emitFn({ type: 'search.failed', at: this.finishedAt, message });
  }

  private assertActive(sha: string, fn: string): void {
    if (this.activeSha === null) {
      throw new BisectError(`${fn}(${short(sha)}) called with no active candidate`);
    }
    if (sha !== this.activeSha) {
      throw new BisectError(
        `${fn}(${short(sha)}) does not match the active candidate ${short(this.activeSha)}`,
      );
    }
  }

  /**
   * Re-derive lo/hi/round/activeSha from the recorded results. One round per
   * distinct commit handed out, so retries of the same sha do not inflate it.
   */
  private replay(persistedRound: number): void {
    let pending: string | null = null;
    let pendingHasResult = false;

    for (;;) {
      if (this.lo > this.hi) break;
      const mid = this.pick();
      if (mid === null) {
        this.roundNo = Object.keys(this.results).length;
        this.fail(`every commit in range [${this.lo}, ${this.hi}] was skipped; cannot narrow further`);
        return;
      }
      const c = this.commits[mid]!;
      const r = this.results[c.sha];
      if (!r) {
        pending = c.sha;
        break;
      }
      if (!RESOLVED.has(r.state)) {
        pending = c.sha; // inconclusive: still owed a verdict, retry it
        pendingHasResult = true;
        break;
      }
      if (r.state === 'good') this.lo = mid + 1;
      else if (r.state === 'bad') this.hi = mid - 1;
      else break; // unreachable: pick() never returns a skipped index
    }

    const tested = Object.keys(this.results).length;
    if (pending && !pendingHasResult) {
      // A persisted round ahead of the result count means round.started was
      // already emitted for this candidate, the crash landed mid-round.
      const midRound = persistedRound > tested;
      this.activeSha = midRound ? pending : null;
      this.roundNo = midRound ? persistedRound : tested;
    } else {
      this.activeSha = pending;
      this.roundNo = tested;
    }
    this.settleIfDone();
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
