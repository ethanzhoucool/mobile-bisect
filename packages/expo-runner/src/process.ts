/**
 * Process-group lifecycle.
 *
 * `npx expo start` is a chain: npx -> @expo/cli -> metro workers. `child.kill()`
 * only reaps the head and leaves Metro holding the port, so every child is
 * spawned detached (its own process group) and killed with `process.kill(-pid)`.
 * Exit is awaited on 'exit', not 'close': a grandchild can hold the inherited
 * stdio pipes open past the parent's death.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface SpawnGroupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Lines of combined stdout+stderr to retain for error messages. Default 60. */
  keepLines?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ManagedProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<ExitInfo>;

  private readonly keepLines: number;
  private lines: string[] = [];
  private partial = '';
  private exitInfo: ExitInfo | undefined;
  private spawnError: Error | undefined;
  private stopping: Promise<void> | undefined;

  constructor(command: string, args: string[], opts: SpawnGroupOptions = {}) {
    this.command = command;
    this.args = [...args];
    this.keepLines = opts.keepLines ?? 60;

    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    this.child = spawn(command, args, spawnOpts);

    if (typeof this.child.pid !== 'number') {
      throw new Error(`failed to spawn ${command} ${args.join(' ')}`);
    }
    this.pid = this.child.pid;

    // Do not hold the event loop open: dispose/beforeExit handle the teardown.
    this.child.unref();
    unrefStream(this.child.stdout);
    unrefStream(this.child.stderr);
    this.child.stdout?.on('data', (c: Buffer) => this.absorb(c));
    this.child.stderr?.on('data', (c: Buffer) => this.absorb(c));

    this.exited = new Promise<ExitInfo>((resolve) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      };
      this.child.once('exit', settle);
      this.child.once('error', (err: Error) => {
        this.spawnError = err;
        this.absorb(Buffer.from(`spawn error: ${err.message}\n`));
        settle(null, null);
      });
    });
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  get exitError(): Error | undefined {
    return this.spawnError;
  }

  /** Last `n` captured output lines, for readiness-timeout diagnostics. */
  tail(n = 20): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-n).join('\n');
  }

  /** SIGTERM the group, then SIGKILL after `graceMs`. Resolves after real exit. */
  stop(graceMs = 5_000): Promise<void> {
    if (this.hasExited) return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      killProcessGroup(this.pid, 'SIGTERM');
      if (await settledWithin(this.exited, graceMs)) return;
      killProcessGroup(this.pid, 'SIGKILL');
      if (await settledWithin(this.exited, 10_000)) return;
      throw new Error(
        `${this.command} (pid ${this.pid}) did not exit after SIGKILL; it may be in uninterruptible sleep`,
      );
    })();
    return this.stopping;
  }

  /** Synchronous last resort for signal handlers, which cannot await. */
  killSync(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.hasExited) return;
    killProcessGroup(this.pid, signal);
  }

  private absorb(chunk: Buffer): void {
    const text = this.partial + chunk.toString('utf8');
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.lines.push(line);
    if (this.lines.length > this.keepLines) this.lines = this.lines.slice(-this.keepLines);
  }
}

/** Child stdio pipes are Sockets at runtime but typed as plain streams. */
function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

export function spawnGroup(command: string, args: string[], opts: SpawnGroupOptions = {}): ManagedProcess {
  return new ManagedProcess(command, args, opts);
}

/** Negative pid targets the whole group. Falls back to the lone pid on EPERM. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** The timer stays ref'd: the child is unref'd, so nothing else holds the loop. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Registry + signal handling
// ---------------------------------------------------------------------------

const TRAPPED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Tracks live groups and installs exit handlers ONCE per instance. Handlers are
 * removed on dispose so a long-lived CLI that bisects repeatedly does not leak
 * listeners, and a trapped signal is re-raised so the process still dies with
 * the right disposition.
 */
export class ProcessGroupRegistry {
  private readonly live = new Set<ManagedProcess>();
  private installed = false;
  private firing = false;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private readonly beforeExitHandler = () => {
    this.killAllSync('SIGKILL');
  };

  add(proc: ManagedProcess): void {
    this.live.add(proc);
    void proc.exited.then(() => this.live.delete(proc));
    this.install();
  }

  remove(proc: ManagedProcess): void {
    this.live.delete(proc);
  }

  get size(): number {
    return this.live.size;
  }

  list(): ManagedProcess[] {
    return [...this.live];
  }

  killAllSync(signal: NodeJS.Signals = 'SIGKILL'): void {
    for (const proc of this.live) {
      try {
        proc.killSync(signal);
      } catch {
        // best effort: one bad pid must not block the rest
      }
    }
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    if (process.getMaxListeners() < 20) process.setMaxListeners(20);
    for (const signal of TRAPPED_SIGNALS) {
      const handler = () => {
        if (this.firing) return;
        this.firing = true;
        this.killAllSync('SIGKILL');
        this.uninstall();
        // Re-raise: swallowing SIGINT would make Ctrl-C look broken.
        process.kill(process.pid, signal);
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    process.on('beforeExit', this.beforeExitHandler);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.clear();
    process.off('beforeExit', this.beforeExitHandler);
  }

  /** SIGTERM -> SIGKILL every live group and wait for all of them to exit. */
  async stopAll(graceMs = 5_000): Promise<void> {
    const procs = this.list();
    this.live.clear();
    const results = await Promise.allSettled(procs.map((p) => p.stop(graceMs)));
    this.uninstall();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`failed to stop ${failed.length} process group(s): ${failed[0].reason}`);
    }
  }
}
