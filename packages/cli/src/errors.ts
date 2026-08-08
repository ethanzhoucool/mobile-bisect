import { redact } from './redact.js';

/** An error we already know how to phrase for a human. Never a stack trace. */
export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, opts: { hint?: string; exitCode?: number } = {}) {
    super(redact(message));
    this.name = 'CliError';
    this.hint = opts.hint ? redact(opts.hint) : undefined;
    this.exitCode = opts.exitCode ?? 1;
  }
}

export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}

/** Best-effort message extraction, always scrubbed. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return redact(String(e));
}
