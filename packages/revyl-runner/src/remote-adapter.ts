/**
 * The no-local-toolchain adapter.
 *
 * `@mobile-bisect/native-runner` compiles candidates on the machine running the
 * bisect, which means Xcode, a JDK, an Android SDK — and a laptop pinned for
 * however long the search takes. This adapter compiles them on Revyl's cloud
 * build runners instead: it points `revyl build --remote` at the candidate's
 * worktree, the CLI uploads that tree, the runner executes the project's own
 * build command, and what comes back is a build id ready to install.
 *
 * Two consequences worth knowing:
 *
 *   - It is framework-agnostic. The project's `.revyl/config.yaml` says how to
 *     build itself, so Swift, Kotlin, Flutter and bare React Native all work
 *     through the same path without an adapter each.
 *   - The candidate arrives already registered, so there is nothing to upload
 *     afterwards. `prepare` returns a `buildId` and no `appPath`.
 */

import { cp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CandidatePrepareError,
  type AdapterDetection,
  type FrameworkAdapter,
  type Platform,
  type PrepareContext,
  type PreparedCandidate,
} from '@mobile-bisect/core';
import * as cli from './cli-adapter.js';
import { RevylInfraError } from './errors.js';
import {
  createExecutor,
  resolveRevylCli,
  type CliExecutor,
  type CliResult,
} from './exec.js';

export interface RevylRemoteAdapterOptions {
  /** The user's repo root. The build config is read from, and seeded from, here. */
  projectRoot: string;
  /** Remote build image, e.g. `ios-macos-26-xcode-26.2`. Config decides when omitted. */
  image?: string;
  /** Per-candidate build budget in seconds. Default 2700 (45 min). */
  buildTimeoutSec?: number;
  /** Default: resolve `revyl` from PATH, then ~/.revyl/bin/revyl. */
  cliPath?: string;
  onLog?: (line: string) => void;
  /** Injected in tests so the suite never starts a cloud build. */
  executor?: CliExecutor;
}

/** Where a Revyl project keeps its build configuration. */
const CONFIG_DIR = '.revyl';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const DEFAULT_BUILD_TIMEOUT_SEC = 2700;

export class RevylRemoteAdapter implements FrameworkAdapter {
  readonly name = 'revyl-remote';
  readonly displayName = 'Revyl cloud build';
  readonly candidateKind = 'binary' as const;

  private readonly opts: RevylRemoteAdapterOptions;
  private executorPromise?: Promise<CliExecutor>;
  /** sha -> build id, so a retry within a run does not rebuild. */
  private readonly built = new Map<string, string>();

  constructor(opts: RevylRemoteAdapterOptions) {
    if (!opts?.projectRoot) throw new Error('RevylRemoteAdapter requires a projectRoot');
    this.opts = opts;
  }

  // --- detection -----------------------------------------------------------

  async detect(projectPath: string): Promise<AdapterDetection> {
    let config: string;
    try {
      config = await readFile(path.join(projectPath, CONFIG_FILE), 'utf8');
    } catch {
      return {
        ok: false,
        confidence: 0,
        platforms: [],
        reason:
          `no ${CONFIG_FILE} here. Run \`revyl init\` and configure a build command, ` +
          'then every candidate can be built in the cloud instead of on this machine.',
      };
    }

    const platforms = platformsIn(config);
    if (platforms.length === 0) {
      return {
        ok: false,
        confidence: 0.4,
        platforms: [],
        reason: `${CONFIG_FILE} has no \`build.platforms\` entry, so there is no build command to run.`,
      };
    }

    return {
      ok: true,
      // Deliberately below every local adapter. Building in the cloud is the
      // right answer when there is no toolchain here, not the default when
      // there is — a local build has no upload and no queue.
      confidence: 0.35,
      platforms,
      summary: `${CONFIG_FILE} · builds ${platforms.join(' + ')} on Revyl runners`,
    };
  }

  // --- preparation ---------------------------------------------------------

  async prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate> {
    const cached = this.built.get(sha);
    if (cached) {
      ctx.onLog?.(`[${short(sha)}] reusing build ${cached}`);
      return this.candidate(sha, worktreePath, ctx.platform, cached, { cached: true });
    }

    const started = Date.now();
    const seeded = await this.seedConfig(worktreePath, sha);
    try {
      const exec = await this.exec();
      ctx.onLog?.(`[${short(sha)}] building on a Revyl ${ctx.platform} runner…`);

      const res = await exec(
        cli.inDirectory(
          worktreePath,
          cli.remoteBuildArgs({
            platform: ctx.platform,
            version: short(sha),
            ...(this.opts.image ? { image: this.opts.image } : {}),
            timeoutSec: this.timeoutSec(),
          }),
        ),
        // The CLI waits for the runner, so our budget must exceed the build's.
        { timeoutMs: (this.timeoutSec() + 300) * 1000 },
      );

      if (res.code !== 0) {
        throw new CandidatePrepareError(remoteFailureMessage(sha, res), {
          sha,
          adapter: this.name,
        });
      }

      const parsed = cli.parseUploadedBuild(res);
      if (!parsed) {
        throw new CandidatePrepareError(
          `the remote build for ${short(sha)} finished but returned no build id, so nothing can be installed`,
          { sha, adapter: this.name },
        );
      }

      this.built.set(sha, parsed.buildId);
      const ms = Date.now() - started;
      ctx.onLog?.(`[${short(sha)}] built in ${Math.round(ms / 1000)}s -> ${parsed.buildId}`);
      return this.candidate(sha, worktreePath, ctx.platform, parsed.buildId, { durationMs: ms });
    } finally {
      // The seeded config is ours, not the commit's. Leaving it behind would
      // make the worktree diff lie about what the candidate contained.
      if (seeded) await rm(path.join(worktreePath, CONFIG_DIR), { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * `.revyl/` is usually untracked, and a detached worktree only contains what
   * the commit tracked — so the build config has to be copied in from the
   * user's checkout or the CLI has nothing to build with.
   *
   * The build *command* is a different matter: it runs at the candidate commit,
   * so it has to be committed. A script that only exists in the working tree
   * will be missing exactly when the bisect needs it.
   */
  private async seedConfig(worktreePath: string, sha: string): Promise<boolean> {
    const target = path.join(worktreePath, CONFIG_DIR);
    if (await exists(target)) return false;

    const source = path.join(this.opts.projectRoot, CONFIG_DIR);
    if (!(await exists(source))) {
      throw new CandidatePrepareError(
        `no ${CONFIG_FILE} in ${this.opts.projectRoot}, so ${short(sha)} cannot be built remotely`,
        { sha, adapter: this.name },
      );
    }
    await cp(source, target, { recursive: true });
    return true;
  }

  private candidate(
    sha: string,
    worktreePath: string,
    platform: Platform,
    buildId: string,
    extra: { cached?: boolean; durationMs?: number },
  ): PreparedCandidate {
    return {
      kind: 'binary',
      sha,
      worktreePath,
      platform,
      // Already registered with the runtime, so there is no artifact to upload.
      buildId,
      ...extra,
      dispose: async () => {},
    };
  }

  private timeoutSec(): number {
    return this.opts.buildTimeoutSec ?? DEFAULT_BUILD_TIMEOUT_SEC;
  }

  private async exec(): Promise<CliExecutor> {
    if (this.opts.executor) return this.opts.executor;
    this.executorPromise ??= (async () => {
      const cliPath = await resolveRevylCli(this.opts.cliPath);
      return createExecutor({ cliPath, onLog: this.opts.onLog });
    })();
    return this.executorPromise;
  }
}

/**
 * A remote build fails for two very different reasons, and the message has to
 * say which: the commit does not compile (skip it and move on), or the runner
 * never got that far (an infrastructure problem the search must not blame on a
 * commit). Both surface as `skipped`, but only one is worth investigating.
 */
function remoteFailureMessage(sha: string, res: CliResult): string {
  const detail = (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).slice(0, 2000);
  const infra = /queue|capacity|runner|sandbox image|unauthorized|network|timeout/i.test(detail);
  return [
    `the remote build for ${short(sha)} failed`,
    infra ? '(this looks like a runner problem rather than a bad commit)' : '',
    `\n--- revyl build --remote ---\n${detail}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * `build.platforms:` keys, without pulling in a YAML parser for two words.
 *
 * Line-wise rather than regex-over-the-whole-string: `\s` matches newlines, so
 * measuring the block's indentation from a multiline match silently counts the
 * line break and every child looks dedented.
 */
export function platformsIn(configYaml: string): Platform[] {
  const lines = configYaml.split('\n');
  const start = lines.findIndex((l) => /^\s*platforms:\s*$/.test(l));
  if (start === -1) return [];

  const out: Platform[] = [];
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const width = line.length - line.trimStart().length;
    indent ??= width;
    if (width < indent) break; // dedented out of the platforms block
    if (width > indent) continue; // a key inside one platform
    const key = /^\s*([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1];
    // Keys may be build variants (`ios-dev`), so match on the prefix.
    if (key?.startsWith('ios') && !out.includes('ios')) out.push('ios');
    if (key?.startsWith('android') && !out.includes('android')) out.push('android');
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

export { RevylInfraError };
