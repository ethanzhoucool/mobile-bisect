/**
 * Secret scrubbing.
 *
 * The rules live in `@expo-bisect/core` so the CLI, the runner and the report
 * all scrub identically; this module is the CLI's synchronous entry point onto
 * them. Everything that reaches events.jsonl, state.json, the report or the
 * terminal passes through here, so a run directory is safe to attach to a bug
 * report as-is.
 */

import { redactString, redactValue } from '@expo-bisect/core';

export const REDACTED = '[redacted]';

export function redact(input: string): string {
  return input ? redactString(input) : input;
}

/** Structure-preserving scrub: keys are left alone, string values are cleaned. */
export function redactDeep<T>(value: T): T {
  return redactValue(value);
}

/** True if the text still carries anything key-shaped. Used by the tests. */
export function containsSecret(text: string): boolean {
  return redactString(text) !== text;
}
