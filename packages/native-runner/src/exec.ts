/**
 * One-shot build processes.
 *
 * `expo-runner` manages servers that must stay up; this manages compilers that
 * must finish. The differences are what this file is for: a build has a
 * deadline, produces megabytes of output nobody wants unless it fails, and
 * spawns a tree (xcodebuild -> clang/swiftc, gradlew -> the Gradle daemon's
 * workers) that only a process-group kill fully reaps.
 */

import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Hard deadline. The group is SIGTERM'd, then SIGKILL'd. */
  timeoutMs?: number;
  /** Ctrl-C from the CLI. Same teardown as a timeout, different verdict. */
  signal?: AbortSignal;
  /** Every output line, live. Build logs are noisy — callers usually filter. */
  onLine?: (line: string) => void;
  /** Output lines retained for the failure message. Default 80. */
  keepLines?: number;
}

export interface ExecOutcome {
  command: string;
  args: readonly string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** The retained tail of combined stdout+stderr. */
  output: string;
  ok: boolean;
}

/** What the adapters call. Swapped in tests so no compiler is ever spawned. */
export type ExecFn = (command: string, args: string[], opts: ExecOptions) => Promise<ExecOutcome>;

const GRACE_MS = 5_000;

export const execBuild: ExecFn = (command, args, opts) =>
  new Promise<ExecOutcome>((resolve, reject) => {
    const started = Date.now();
    const keep = opts.keepLines ?? 80;
    const lines: string[] = [];
    let partial = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const absorb = (chunk: Buffer): void => {
      const text = partial + chunk.toString('utf8');
      const parts = text.split('\n');
      partial = parts.pop() ?? '';
      for (const line of parts) {
        opts.onLine?.(line);
        lines.push(line);
      }
      if (lines.length > keep) lines.splice(0, lines.length - keep);
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);

    let killTimer: NodeJS.Timeout | undefined;
    const teardown = (): void => {
      if (settled) return;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), GRACE_MS);
      killTimer.unref();
    };

    const deadline = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          teardown();
        }, opts.timeoutMs)
      : undefined;

    const onAbort = (): void => {
      aborted = true;
      teardown();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (err: Error) => {
      cleanup();
      reject(new Error(`could not run \`${command}\`: ${err.message}`, { cause: err }));
    });

    child.once('exit', (code, signal) => {
      cleanup();
      if (partial) lines.push(partial);
      resolve({
        command,
        args: [...args],
        code,
        signal,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        output: lines.slice(-keep).join('\n'),
        ok: code === 0 && !timedOut && !aborted,
      });
    });
  });

/** Negative pid reaps the whole group; a lone pid is the EPERM fallback. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number') return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      process.kill(pid, signal);
    } catch {
      // best effort
    }
  }
}

export class BuildError extends Error {
  readonly outcome: ExecOutcome;

  constructor(what: string, outcome: ExecOutcome) {
    super(`${what}: ${describe(outcome)}\n--- last output ---\n${outcome.output}`);
    this.name = 'BuildError';
    this.outcome = outcome;
  }
}

function describe(o: ExecOutcome): string {
  if (o.aborted) return 'cancelled';
  if (o.timedOut) return `timed out after ${Math.round(o.durationMs / 1000)}s`;
  if (o.signal) return `killed by ${o.signal}`;
  return `exit ${o.code}`;
}

/**
 * Serialises builds.
 *
 * Two xcodebuilds at once are slower than one after the other — they contend
 * for the same cores — and they corrupt a shared derived-data directory. The
 * search may still evaluate candidates speculatively; they queue here.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
