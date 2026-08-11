import type { RunVerdict } from '@mobile-bisect/core';
import { redactWithEnv } from './redact.js';

/**
 * Every error this package throws carries the verdict the bisector should
 * record, so no caller has to re-derive the pass/fail/inconclusive decision
 * from a message string.
 */
export class RevylError extends Error {
  readonly verdict: RunVerdict;
  /** Short machine tag, e.g. `cli-missing`, `session-start`, `install`. */
  readonly stage: string;
  readonly exitCode?: number;

  constructor(message: string, opts: { verdict: RunVerdict; stage: string; exitCode?: number }) {
    super(redactWithEnv(message));
    this.name = 'RevylError';
    this.verdict = opts.verdict;
    this.stage = opts.stage;
    this.exitCode = opts.exitCode;
  }
}

/**
 * The device, the install, or the bundle load failed, we learned nothing about
 * the commit. The bisector retries once, then skips.
 */
export class RevylInfraError extends RevylError {
  constructor(message: string, opts: { stage: string; exitCode?: number }) {
    super(message, { ...opts, verdict: 'inconclusive' });
    this.name = 'RevylInfraError';
  }
}

/** Auth or CLI resolution failed. Fatal for the whole run, not just one commit. */
export class RevylAuthError extends RevylError {
  constructor(message: string, opts: { stage: string; exitCode?: number } = { stage: 'auth' }) {
    super(message, { ...opts, verdict: 'inconclusive' });
    this.name = 'RevylAuthError';
  }
}

/** A flow step this adapter cannot express as a Revyl CLI command. */
export class UnsupportedStepError extends RevylError {
  constructor(message: string) {
    super(message, { verdict: 'inconclusive', stage: 'flow' });
    this.name = 'UnsupportedStepError';
  }
}
