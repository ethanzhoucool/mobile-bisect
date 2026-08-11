/**
 * Verdict classification, the single most load-bearing decision in the tool.
 *
 * A bisect is only as honest as its ability to tell "the app is broken" from
 * "the harness is broken". Get it wrong in one direction and a flaky device
 * gets a commit blamed for someone else's bug; wrong in the other and a real
 * regression is skipped and the search converges on nothing.
 *
 * The rule: `fail` requires positive evidence that the app answered the
 * question and answered it wrong. Everything else is `inconclusive`.
 */

import type { RunVerdict } from '@mobile-bisect/core';
import type { StepOutcome } from './cli-adapter.js';

/**
 * stderr shapes that mean the harness broke, captured from CLI v0.1.71.
 * `Error: validation failed` is deliberately absent, that one is the app
 * answering "no", which is a real `fail`.
 */
const INFRA_STDERR = [
  /context deadline exceeded/i,
  /proxy request failed/i,
  /backend device control request failed/i,
  /request failed:/i,
  /connection (refused|reset)/i,
  /no active session/i,
  /session (not found|expired|has ended|is not running)/i,
  /failed to (start|create|provision|attach)/i,
  /installation failed/i,
  /unauthorized|forbidden|401|403|REVYL_API_KEY/i,
  /device .*(unavailable|not available|busy)/i,
  /worker .*(unreachable|unhealthy)/i,
  /i\/o timeout|EOF|network is unreachable/i,
];

/** The exact stderr the CLI emits when an assertion legitimately evaluates false. */
export const VALIDATION_FAILED_STDERR = /^Error:\s*validation failed/im;

/** Does this failed command look like broken infrastructure rather than a broken app? */
export function isInfraFailure(o: Pick<StepOutcome, 'code' | 'stderr' | 'timedOut' | 'spawnError' | 'workerResponded'>): boolean {
  if (o.spawnError) return true;
  if (o.timedOut) return true;
  if (o.code === 0) return false;
  if (VALIDATION_FAILED_STDERR.test(o.stderr)) return false;
  if (INFRA_STDERR.some((re) => re.test(o.stderr))) return true;
  // Non-zero with no envelope and no recognised message: the worker never
  // answered, so we cannot claim to know anything about the commit.
  return !o.workerResponded;
}

export interface ClassifyInput {
  /** The assertion validation, if we managed to run it. */
  assertion?: StepOutcome;
  /** First action step that did not complete, if any. */
  failedAction?: { outcome: StepOutcome; label: string };
  /** Set when the session, install or bundle load failed before the flow ran. */
  infraReason?: string;
  stepsCompleted: number;
}

export interface Classification {
  verdict: RunVerdict;
  reason: string;
}

function firstSentence(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const stop = trimmed.search(/(?<=\.)\s/);
  const out = stop > 20 ? trimmed.slice(0, stop) : trimmed;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Prefer the model's own words; they read well under the device in the report. */
function assertionReason(o: StepOutcome, fallback: string): string {
  const text = o.reasoning ?? o.statusReason;
  return text ? firstSentence(text) : fallback;
}

export function classify(input: ClassifyInput): Classification {
  const { assertion, failedAction, infraReason } = input;

  if (infraReason) {
    return { verdict: 'inconclusive', reason: firstSentence(infraReason) };
  }

  if (!assertion) {
    const detail = failedAction
      ? `the flow stopped at "${failedAction.label}" and the assertion was never evaluated`
      : 'the assertion was never evaluated';
    return { verdict: 'inconclusive', reason: `No verdict: ${detail}.` };
  }

  if (isInfraFailure(assertion)) {
    const detail = assertion.timedOut
      ? 'the assertion timed out on the device'
      : assertion.stderr || assertion.spawnError || 'the device did not answer';
    return { verdict: 'inconclusive', reason: `Could not evaluate the assertion: ${firstSentence(detail)}` };
  }

  // The worker reached a verdict only when its own step machinery succeeded.
  // `success: false` + `status: "success"` is precisely a failing assertion.
  const workerCompleted = assertion.status === undefined || assertion.status === 'success';
  if (!workerCompleted) {
    return {
      verdict: 'inconclusive',
      reason: `Could not evaluate the assertion: worker reported status "${assertion.status}".`,
    };
  }

  if (assertion.validationResult === true) {
    return { verdict: 'pass', reason: assertionReason(assertion, 'The assertion held.') };
  }
  if (assertion.validationResult === false) {
    return { verdict: 'fail', reason: assertionReason(assertion, 'The assertion did not hold.') };
  }

  // Envelope came back healthy but carried no boolean, treat the absence of an
  // answer as an absence of evidence, never as a failure.
  if (assertion.success === true) {
    return { verdict: 'pass', reason: assertionReason(assertion, 'The assertion held.') };
  }
  return {
    verdict: 'inconclusive',
    reason: 'Could not evaluate the assertion: the device returned no validation result.',
  };
}
