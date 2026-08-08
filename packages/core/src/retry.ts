/**
 * Retry policy for inconclusive candidate runs.
 *
 * A device that drops mid-flow tells us nothing about the commit, so we run it
 * once more; if it is still inconclusive the commit is skipped and the search
 * routes around it (git-bisect-skip semantics) rather than guessing.
 */

import type { CommitState, RunVerdict } from './types.js';

export type TerminalState = Extract<CommitState, 'good' | 'bad' | 'skipped'>;

export type RetryDecision =
  | { action: 'accept'; state: 'good' | 'bad' }
  | { action: 'retry'; attempt: number }
  | { action: 'downgrade'; state: 'skipped'; reason: string };

export interface RetryPolicyOptions {
  /** Total attempts allowed per commit, including the first. Default 2. */
  maxAttempts?: number;
}

export interface RetryOutcome<T> {
  /** The last attempt's result. */
  result: T;
  /** How many times the runner was invoked. */
  attempts: number;
  state: TerminalState;
  /** True when an inconclusive run exhausted its retries and became `skipped`. */
  downgraded: boolean;
  /** Present when `downgraded`; safe to surface as the CommitResult reason. */
  reason?: string;
}

export function verdictToState(verdict: RunVerdict): 'good' | 'bad' | 'inconclusive' {
  if (verdict === 'pass') return 'good';
  if (verdict === 'fail') return 'bad';
  return 'inconclusive';
}

export class RetryPolicy {
  readonly maxAttempts: number;

  constructor(opts: RetryPolicyOptions = {}) {
    const max = opts.maxAttempts ?? 2;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxAttempts must be an integer >= 1, got ${String(opts.maxAttempts)}`);
    }
    this.maxAttempts = max;
  }

  /** Pure: what to do given a verdict on attempt number `attempt` (1-based). */
  decide(verdict: RunVerdict, attempt: number): RetryDecision {
    const state = verdictToState(verdict);
    if (state !== 'inconclusive') return { action: 'accept', state };
    if (attempt < this.maxAttempts) return { action: 'retry', attempt: attempt + 1 };
    return {
      action: 'downgrade',
      state: 'skipped',
      reason: `Inconclusive on ${attempt} of ${this.maxAttempts} attempts; skipping this commit.`,
    };
  }

  /** Drive `attempt` until a terminal decision, applying `decide` between runs. */
  async run<T extends { verdict: RunVerdict }>(
    attempt: (attemptNumber: number) => Promise<T>,
  ): Promise<RetryOutcome<T>> {
    let n = 0;
    for (;;) {
      n += 1;
      const result = await attempt(n);
      const decision = this.decide(result.verdict, n);
      if (decision.action === 'accept') {
        return { result, attempts: n, state: decision.state, downgraded: false };
      }
      if (decision.action === 'downgrade') {
        return {
          result,
          attempts: n,
          state: 'skipped',
          downgraded: true,
          reason: decision.reason,
        };
      }
    }
  }
}
