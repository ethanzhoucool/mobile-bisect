/**
 * Loads the recorded CLI output under `fixtures/`.
 *
 * Everything in there was captured from a live Revyl CLI v0.1.71 session and
 * then scrubbed of ids and signatures, so the tests parse real shapes without
 * ever starting a cloud device.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CliResult } from './exec.js';

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)), 'utf8');
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export interface RecordedError {
  stage: string;
  stdout: string;
  stderr: string;
  code: number;
}

export function recordedErrors(): Record<string, RecordedError> {
  return fixtureJson<Record<string, RecordedError>>('cli-errors');
}

/** Wrap a fixture as the `CliResult` an executor would have produced. */
export function ok(name: string, argv: string[] = []): CliResult {
  return { argv, code: 0, stdout: fixtureText(name), stderr: '', durationMs: 12, timedOut: false };
}

export function fail(opts: Partial<CliResult> & { stderr: string }): CliResult {
  return {
    argv: [],
    code: 1,
    stdout: '',
    durationMs: 12,
    timedOut: false,
    ...opts,
  };
}
