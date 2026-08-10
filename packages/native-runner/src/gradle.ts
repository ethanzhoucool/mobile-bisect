/**
 * The Gradle adapter: Kotlin and Java Android apps, built per candidate.
 *
 * Same shape as the Xcode adapter — build, cache by SHA, serialise — with one
 * difference that matters. Gradle's own build cache lives in `~/.gradle` and is
 * keyed by task inputs, not by path, so it survives the throwaway worktrees
 * that defeat Xcode's incremental build. `--build-cache` is on by default for
 * exactly that reason: the second candidate is usually much faster than the
 * first, even though it compiles in a directory that has never existed before.
 */

import path from 'node:path';
import { copyFile, readFile } from 'node:fs/promises';
import {
  CandidatePrepareError,
  type AdapterDetection,
  type FrameworkAdapter,
  type Platform,
  type PrepareContext,
  type PreparedCandidate,
} from '@mobile-bisect/core';
import { findApk } from './artifact.js';
import { BuildCache, type CacheKey } from './cache.js';
import { detectGradleProject, parseApplicationId, type GradleProject } from './detect.js';
import { BuildError, execBuild, Mutex, type ExecFn } from './exec.js';

export interface GradleAdapterOptions {
  /** The user's repo root. Only used to place the cache. */
  projectRoot: string;
  cacheDir?: string;
  /** Subdirectory of the worktree holding the Gradle build, e.g. `android`. */
  projectDir?: string;
  /** Gradle module to assemble. Default `app`. */
  module?: string;
  /** Build variant. Default `debug` — a release variant needs signing config. */
  variant?: string;
  /** Overrides module+variant entirely, e.g. `:app:assembleFreeDebug`. */
  task?: string;
  /** Per-candidate build budget. Default 30 minutes. */
  buildTimeoutMs?: number;
  /** Pass `--build-cache`. Default true. */
  buildCache?: boolean;
  /** Appended verbatim to every gradle invocation. */
  extraArgs?: string[];
  /** Default: `./gradlew` when a wrapper exists, else `gradle`. */
  gradlePath?: string;
  /** Cached builds retained per configuration. Default 24. */
  cacheKeep?: number;
  onLog?: (line: string) => void;
  /** Injected in tests so the suite never spawns Gradle. */
  exec?: ExecFn;
}

const DEFAULT_MODULE = 'app';
const DEFAULT_VARIANT = 'debug';
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;

export class GradleAdapter implements FrameworkAdapter {
  readonly name = 'gradle';
  readonly displayName = 'Gradle (Kotlin / Java)';
  readonly candidateKind = 'binary' as const;

  private readonly opts: GradleAdapterOptions;
  private readonly exec: ExecFn;
  private readonly cache: BuildCache;
  private readonly builds = new Mutex();
  private readonly keys = new Map<string, CacheKey>();

  constructor(opts: GradleAdapterOptions) {
    if (!opts?.projectRoot) throw new Error('GradleAdapter requires a projectRoot');
    this.opts = opts;
    this.exec = opts.exec ?? execBuild;
    const cacheDir = opts.cacheDir ?? path.join(opts.projectRoot, '.mobile-bisect', 'build');
    this.cache = new BuildCache(path.join(cacheDir, 'artifacts'));
  }

  // --- detection -----------------------------------------------------------

  async detect(projectPath: string): Promise<AdapterDetection> {
    const found = await detectGradleProject(projectPath);
    if (!found) {
      return {
        ok: false,
        confidence: 0,
        platforms: [],
        reason: 'no settings.gradle or settings.gradle.kts found',
      };
    }

    const module = this.opts.module ?? preferredModule(found);
    if (!module) {
      return {
        ok: false,
        confidence: 0.6,
        platforms: ['android'],
        reason: `settings.gradle lists ${found.modules.length} modules (${found.modules.join(', ')}) and none is called "app". Set \`build.module\`.`,
      };
    }

    return {
      ok: true,
      // Below Expo for the same reason as Xcode: a prebuilt Expo app has an
      // android/ directory, and swapping its JS is faster than assembling it.
      confidence: found.nested ? 0.55 : 0.8,
      platforms: ['android'],
      summary: `Gradle${found.kotlin ? ' (Kotlin)' : ''} module :${module}${found.dir ? ` in ${found.dir}/` : ''}`,
    };
  }

  // --- preparation ---------------------------------------------------------

  async prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate> {
    if (ctx.platform !== 'android') {
      throw new CandidatePrepareError(`the Gradle adapter only builds Android, not ${ctx.platform}`, {
        sha,
        adapter: this.name,
      });
    }

    const found = await this.resolveProject(worktreePath, sha);
    const module = this.opts.module ?? preferredModule(found);
    if (!module) {
      throw new CandidatePrepareError(
        `cannot tell which module to assemble (${found.modules.join(', ')}). Set \`build.module\`.`,
        { sha, adapter: this.name },
      );
    }
    const variant = this.opts.variant ?? DEFAULT_VARIANT;
    const task = this.opts.task ?? `:${module}:assemble${capitalise(variant)}`;

    const key: CacheKey = { sha, platform: 'android', params: { module, variant, task } };
    this.keys.set(sha, key);

    const cached = await this.cache.get(key);
    if (cached) {
      ctx.onLog?.(`[${short(sha)}] reusing the cached build`);
      return this.candidate(sha, worktreePath, cached.appPath, {
        bundleId: cached.bundleId,
        buildId: cached.buildId,
        cached: true,
        durationMs: 0,
      });
    }

    return this.builds.run(async () => {
      const raced = await this.cache.get(key);
      if (raced) {
        return this.candidate(sha, worktreePath, raced.appPath, {
          bundleId: raced.bundleId,
          buildId: raced.buildId,
          cached: true,
          durationMs: 0,
        });
      }
      return this.build(sha, worktreePath, found, key, { module, variant, task }, ctx);
    });
  }

  async noteUploaded(sha: string, buildId: string, platform: Platform): Promise<void> {
    const key = this.keys.get(sha);
    if (!key || key.platform !== platform) return;
    await this.cache.noteBuildId(key, buildId);
  }

  // -------------------------------------------------------------------------

  private async build(
    sha: string,
    worktreePath: string,
    found: GradleProject,
    key: CacheKey,
    cfg: { module: string; variant: string; task: string },
    ctx: PrepareContext,
  ): Promise<PreparedCandidate> {
    const started = Date.now();
    const projectDir = path.join(worktreePath, found.dir);
    const { command, args } = this.gradleArgv(found, cfg);

    ctx.onLog?.(`[${short(sha)}] ${command} ${cfg.task}`);
    const outcome = await this.exec(command, args, {
      cwd: projectDir,
      timeoutMs: this.opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      signal: ctx.signal,
      onLine: (l) => this.log(ctx, sha, l),
    });
    if (!outcome.ok) {
      throw new CandidatePrepareError(
        new BuildError(`${command} ${cfg.task} failed for ${short(sha)}`, outcome).message,
        { sha, adapter: this.name },
      );
    }

    const moduleDir = path.join(projectDir, cfg.module.replace(/:/g, path.sep));
    const apk = await findApk(moduleDir, cfg.variant);
    if (!apk) {
      throw new CandidatePrepareError(
        `${cfg.task} succeeded for ${short(sha)} but no .apk appeared under ${moduleDir}/build/outputs/apk. ` +
          `Is :${cfg.module} an application module rather than a library?`,
        { sha, adapter: this.name },
      );
    }

    // The APK is inside the worktree, which is about to be deleted. Copy it out
    // before anything else touches it.
    const dir = await this.cache.stagingDir(key);
    const dest = path.join(dir, apk.name);
    await copyFile(apk.path, dest);
    const bundleId = await this.readApplicationId(moduleDir);

    const buildMs = Date.now() - started;
    await this.cache.put(key, {
      appPath: dest,
      bundleId,
      builtAt: new Date(started).toISOString(),
      buildMs,
    });
    await this.cache
      .prune({ platform: 'android', params: key.params }, this.opts.cacheKeep ?? 24)
      .catch(() => []);

    ctx.onLog?.(`[${short(sha)}] assembled in ${Math.round(buildMs / 1000)}s -> ${apk.name}`);
    return this.candidate(sha, worktreePath, dest, { bundleId, durationMs: buildMs });
  }

  private gradleArgv(
    found: GradleProject,
    cfg: { task: string },
  ): { command: string; args: string[] } {
    const command =
      this.opts.gradlePath ?? (found.hasWrapper ? `.${path.sep}gradlew` : 'gradle');
    const args = [cfg.task, '--console=plain'];
    if (this.opts.buildCache ?? true) args.push('--build-cache');
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    return { command, args };
  }

  private async resolveProject(worktreePath: string, sha: string): Promise<GradleProject> {
    const searchRoot = this.opts.projectDir
      ? path.join(worktreePath, this.opts.projectDir)
      : worktreePath;
    const found = await detectGradleProject(searchRoot);
    if (!found) {
      throw new CandidatePrepareError(
        `no Gradle project under ${this.opts.projectDir ?? '.'} at ${short(sha)}`,
        { sha, adapter: this.name },
      );
    }
    return this.opts.projectDir
      ? { ...found, dir: path.join(this.opts.projectDir, found.dir) }
      : found;
  }

  private async readApplicationId(moduleDir: string): Promise<string | undefined> {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      try {
        const id = parseApplicationId(await readFile(path.join(moduleDir, name), 'utf8'));
        if (id) return id;
      } catch {
        // no such file, or unreadable — the id is optional
      }
    }
    return undefined;
  }

  private candidate(
    sha: string,
    worktreePath: string,
    appPath: string,
    extra: { bundleId?: string; buildId?: string; cached?: boolean; durationMs?: number },
  ): PreparedCandidate {
    return {
      kind: 'binary',
      sha,
      worktreePath,
      platform: 'android',
      appPath,
      ...extra,
      dispose: async () => {},
    };
  }

  private log(ctx: PrepareContext, sha: string, line: string): void {
    if (!/(^FAILURE|error:|^BUILD |^> Task .*FAILED)/i.test(line)) return;
    const sink = ctx.onLog ?? this.opts.onLog;
    sink?.(`[${short(sha)}] ${line.trim()}`);
  }
}

/** `app` is the Android convention; anything else has to be named explicitly. */
function preferredModule(found: GradleProject): string | undefined {
  if (found.modules.includes('app')) return 'app';
  return found.modules.length === 1 ? found.modules[0] : undefined;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
