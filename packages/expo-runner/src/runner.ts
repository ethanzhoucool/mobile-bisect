/**
 * The core MVP insight: the native binary is built ONCE.
 *
 * A cloud iOS device is already running an Expo dev-client build. To test a
 * candidate commit we only have to make that commit's JavaScript reachable and
 * hand the device a URL — no `eas build` per commit, so a bisect round costs
 * seconds instead of ~20 minutes. `revyl-runner` consumes the `bundleUrl`.
 */

import * as http from 'node:http';
import * as path from 'node:path';

import { detectExpoProject, readAppJson } from './detect.js';
import { defaultCacheDir, installDeps, type InstallDepsOptions } from './deps.js';
import { ManagedProcess, ProcessGroupRegistry, spawnGroup } from './process.js';
import { PortAllocator, type PortAllocatorOptions } from './ports.js';
import { serveDirectory, type StaticServer } from './static-server.js';
import { buildBundleUrls } from './urls.js';

export type PrepareMode = 'metro' | 'export';

export const DEFAULT_READY_TIMEOUT_MS = 180_000;

export interface CandidatePrep {
  /** What the device should open: a dev-client deep link (metro) or the export URL. */
  bundleUrl?: string;
  metroPort?: number;
  dispose(): Promise<void>;
  /** Raw packager URL behind `bundleUrl` in metro mode. */
  metroUrl?: string;
  mode?: PrepareMode;
  sha?: string;
  worktreePath?: string;
  /** `expo export` output dir in export mode. */
  exportDir?: string;
}

export interface ExpoCandidateRunnerOptions {
  /** The user's repo root; only used for default cache placement. */
  projectRoot: string;
  mode?: PrepareMode;
  cacheDir?: string;
  /**
   * Host baked into the URL handed to the device. Defaults to `127.0.0.1`,
   * which a cloud device CANNOT reach on its own — `revyl-runner` supplies a
   * relay/tunnel hostname here. Readiness is always probed on loopback.
   */
  host?: string;
  portRange?: PortAllocatorOptions;
  /** Readiness poll budget per candidate. Default 180000. */
  readyTimeoutMs?: number;
  /** Set false when node_modules is already warm (tests, repeated runs). */
  install?: boolean;
  installOptions?: InstallDepsOptions;
  /** How the Expo CLI is invoked. Default `npx expo`. */
  expoCommand?: { command: string; args?: string[] };
  onLog?: (line: string) => void;
}

interface LivePrep {
  prep: CandidatePrep;
  dispose(): Promise<void>;
}

export class ExpoCandidateRunner {
  readonly projectRoot: string;
  readonly mode: PrepareMode;
  readonly cacheDir: string;
  readonly host: string;

  private readonly ports: PortAllocator;
  private readonly registry = new ProcessGroupRegistry();
  private readonly live = new Set<LivePrep>();
  private readonly opts: ExpoCandidateRunnerOptions;
  private disposed = false;

  constructor(opts: ExpoCandidateRunnerOptions) {
    if (!opts?.projectRoot) throw new Error('ExpoCandidateRunner requires a projectRoot');
    this.opts = opts;
    this.projectRoot = opts.projectRoot;
    this.mode = opts.mode ?? 'metro';
    this.cacheDir = opts.cacheDir ?? defaultCacheDir(opts.projectRoot);
    this.host = opts.host ?? '127.0.0.1';
    this.ports = new PortAllocator(opts.portRange ?? {});
  }

  async prepare(worktreePath: string, sha: string): Promise<CandidatePrep> {
    if (this.disposed) throw new Error('ExpoCandidateRunner has been disposed');

    const detected = await detectExpoProject(worktreePath);
    if (!detected.ok) throw new Error(`cannot prepare ${short(sha)}: ${detected.reason}`);

    if (this.opts.install ?? true) {
      await installDeps(worktreePath, this.cacheDir, {
        onLog: this.opts.installOptions?.onLog ?? this.opts.onLog,
        ...this.opts.installOptions,
      });
    }

    const prep =
      this.mode === 'export'
        ? await this.prepareExport(worktreePath, sha)
        : await this.prepareMetro(worktreePath, sha);
    return prep;
  }

  /** Disposes every outstanding prep and removes the signal handlers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const preps = [...this.live];
    this.live.clear();
    const results = await Promise.allSettled(preps.map((p) => p.dispose()));
    this.registry.uninstall();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`failed to dispose ${failed.length} candidate prep(s): ${failed[0].reason}`);
    }
  }

  /** Live process groups, for tests and orphan checks. */
  get liveProcesses(): ManagedProcess[] {
    return this.registry.list();
  }

  // -------------------------------------------------------------------------

  private async prepareMetro(worktreePath: string, sha: string): Promise<CandidatePrep> {
    const port = await this.ports.allocate();
    let proc: ManagedProcess | undefined;
    try {
      const { command, args } = this.expoArgv([
        'start',
        '--port',
        String(port),
        '--dev-client',
        '--non-interactive',
      ]);
      this.log(`[${short(sha)}] ${command} ${args.join(' ')}`);
      proc = spawnGroup(command, args, { cwd: worktreePath, env: this.childEnv() });
      this.registry.add(proc);

      await waitForMetro(proc, port, this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

      const appConfig = await readAppJson(worktreePath);
      const urls = buildBundleUrls({ appConfig, host: this.host, port });
      if (!urls.bundleUrl) {
        this.log(
          `[${short(sha)}] no expo.scheme/expo.slug in app.json — handing back the raw packager URL`,
        );
      }

      const started = proc;
      return this.track({
        bundleUrl: urls.bundleUrl ?? urls.metroUrl,
        metroUrl: urls.metroUrl,
        metroPort: port,
        mode: 'metro',
        sha,
        worktreePath,
        dispose: async () => {
          await started.stop();
          this.registry.remove(started);
          this.ports.release(port);
        },
      });
    } catch (err) {
      // A half-started Metro would hold the port for the whole bisect.
      if (proc) {
        await proc.stop().catch(() => {});
        this.registry.remove(proc);
      }
      this.ports.release(port);
      throw err;
    }
  }

  private async prepareExport(worktreePath: string, sha: string): Promise<CandidatePrep> {
    const outputDir = path.join(this.cacheDir, 'exports', sha);
    const { command, args } = this.expoArgv([
      'export',
      '--platform',
      'ios',
      '--output-dir',
      outputDir,
    ]);
    this.log(`[${short(sha)}] ${command} ${args.join(' ')}`);

    const proc = spawnGroup(command, args, { cwd: worktreePath, env: this.childEnv() });
    this.registry.add(proc);
    const timeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let exit;
    try {
      exit = await withTimeout(proc.exited, timeoutMs, () => {
        throw new Error(`expo export timed out after ${timeoutMs}ms\n--- output ---\n${proc.tail()}`);
      });
    } finally {
      await proc.stop().catch(() => {});
      this.registry.remove(proc);
    }
    if (exit.code !== 0) {
      throw new Error(
        `expo export failed for ${short(sha)} (exit ${exit.code ?? 'signal ' + exit.signal})\n` +
          `--- output ---\n${proc.tail()}`,
      );
    }

    const port = await this.ports.allocate();
    let server: StaticServer | undefined;
    try {
      server = await serveDirectory(outputDir, port);
      await waitForHttp(`http://127.0.0.1:${port}/status`, 10_000);
      const started = server;
      const bundleUrl = `http://${this.host}:${port}/`;
      return this.track({
        bundleUrl,
        metroPort: port,
        mode: 'export',
        sha,
        worktreePath,
        exportDir: outputDir,
        dispose: async () => {
          await started.close();
          this.ports.release(port);
        },
      });
    } catch (err) {
      await server?.close().catch(() => {});
      this.ports.release(port);
      throw err;
    }
  }

  private track(prep: CandidatePrep): CandidatePrep {
    const inner = prep.dispose.bind(prep);
    let done: Promise<void> | undefined;
    const entry: LivePrep = {
      prep,
      dispose: () => {
        done ??= inner().finally(() => {
          this.live.delete(entry);
        });
        return done;
      },
    };
    prep.dispose = () => entry.dispose();
    this.live.add(entry);
    return prep;
  }

  private expoArgv(extra: string[]): { command: string; args: string[] } {
    const command = this.opts.expoCommand?.command ?? 'npx';
    const base = this.opts.expoCommand?.args ?? (command === 'npx' ? ['expo'] : []);
    return { command, args: [...base, ...extra] };
  }

  /**
   * CI is stripped, not set: `CI=1` makes @expo/cli disable Fast Refresh, which
   * is exactly the mechanism the bisect depends on.
   */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1' };
    delete env.CI;
    delete env.EXPO_NO_DOTENV;
    return env;
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Polls Metro's `/status`, which answers `packager-status:running`. Scraping
 * stdout for a banner breaks on every @expo/cli release, so stdout is only kept
 * for the error message.
 */
export async function waitForMetro(proc: ManagedProcess, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not yet listening';

  while (Date.now() < deadline) {
    if (proc.hasExited) {
      throw new Error(
        `the Expo CLI exited before Metro was ready on port ${port}\n--- output ---\n${proc.tail()}`,
      );
    }
    try {
      const body = await httpGet(`http://127.0.0.1:${port}/status`, 3_000);
      if (body.includes('packager-status:running')) return;
      lastError = `unexpected /status body: ${body.slice(0, 80)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }

  throw new Error(
    `Metro was not ready on port ${port} within ${timeoutMs}ms (last probe: ${lastError})\n` +
      `--- expo output ---\n${proc.tail()}`,
  );
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      await httpGet(url, 2_000);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(`${url} did not respond within ${timeoutMs}ms (${lastError})`);
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

/**
 * Deliberately NOT unref'd: the spawned child and its pipes are unref'd, so an
 * unref'd poll timer would let node drain the loop and exit mid-readiness.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
