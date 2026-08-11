/**
 * The only place this package spawns a process.
 *
 * `execFile` with an argv array, never a shell string, so a flow label or an
 * assertion containing quotes, `$(…)` or `;` is inert. A non-zero exit is a
 * value, not a throw: classification decides what it means.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { RevylAuthError } from './errors.js';
import { redactWithEnv } from './redact.js';

export interface CliResult {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the binary could not be spawned at all (ENOENT, EACCES). */
  spawnError?: string;
}

export interface CliExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** Injectable so tests can replay recorded fixtures instead of calling the cloud. */
export type CliExecutor = (args: string[], opts?: CliExecOptions) => Promise<CliResult>;

/** Sensible ceiling: a grounded vision step can legitimately take a minute. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

/** Big enough for a `device report --json` with dozens of steps and base64 frames. */
const MAX_BUFFER = 64 * 1024 * 1024;

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit path, then `REVYL_CLI`, then `revyl` on PATH, then the installer's
 * default location. Resolution is done in-process, no `which` subshell.
 */
export async function resolveRevylCli(cliPath?: string): Promise<string> {
  const explicit = cliPath ?? process.env.REVYL_CLI;
  if (explicit) {
    if (await isExecutable(explicit)) return explicit;
    throw new RevylAuthError(`Revyl CLI at "${explicit}" is not executable.`, { stage: 'cli-missing' });
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'revyl');
    if (await isExecutable(candidate)) return candidate;
  }

  const fallback = join(homedir(), '.revyl', 'bin', 'revyl');
  if (await isExecutable(fallback)) return fallback;

  throw new RevylAuthError(
    'Revyl CLI not found. Install it (https://docs.revyl.ai) or set REVYL_CLI to its path.',
    { stage: 'cli-missing' },
  );
}

export interface CreateExecutorOptions {
  cliPath: string;
  onLog?: (line: string) => void;
  defaultTimeoutMs?: number;
  cwd?: string;
}

export function createExecutor(opts: CreateExecutorOptions): CliExecutor {
  const { cliPath, onLog } = opts;
  return async (args, callOpts = {}) => {
    const started = Date.now();
    const timeoutMs = callOpts.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    onLog?.(redactWithEnv(`$ revyl ${args.join(' ')}`));

    return await new Promise<CliResult>((resolve) => {
      const child = execFile(
        cliPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          cwd: callOpts.cwd ?? opts.cwd,
          // The CLI reads ~/.revyl/credentials.json or REVYL_API_KEY itself; we
          // never construct, forward or log a credential of our own.
          env: process.env,
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          const spawnError =
            e && typeof e.code === 'string' ? `${e.code}: ${e.message}` : undefined;
          const timedOut = Boolean(e && (e as { killed?: boolean }).killed) && !spawnError;
          const code = spawnError ? -1 : typeof e?.code === 'number' ? e.code : e ? 1 : 0;

          const result: CliResult = {
            argv: args,
            code,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            durationMs: Date.now() - started,
            timedOut,
            ...(spawnError ? { spawnError } : {}),
          };
          if (result.stderr.trim()) onLog?.(redactWithEnv(result.stderr.trim()));
          resolve(result);
        },
      );
      child.on('error', () => {
        /* surfaced through the callback above */
      });
    });
  };
}
