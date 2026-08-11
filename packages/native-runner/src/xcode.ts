/**
 * The Xcode adapter: Swift and Objective-C apps, built per candidate.
 *
 * This is the honest, slow path. There is no equivalent of the JS swap here -
 * a Swift change *is* a native change, so every candidate is a real compile.
 * Three things keep that bearable:
 *
 *   - derived data is shared across candidates, so module caches survive
 *   - finished artifacts are cached by SHA, so retries and resumes are free
 *   - builds are serialised, because two xcodebuilds fight over the same cores
 *
 * A 64-commit range is 6 builds, not 64. That is the whole point of bisecting.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CandidatePrepareError,
  type AdapterDetection,
  type FrameworkAdapter,
  type Platform,
  type PrepareContext,
  type PreparedCandidate,
} from '@mobile-bisect/core';
import { findSimulatorApp, readBundleId, zipApp } from './artifact.js';
import { BuildCache, type CacheKey } from './cache.js';
import { detectXcodeProject, type XcodeProject } from './detect.js';
import { BuildError, execBuild, Mutex, type ExecFn } from './exec.js';

export interface XcodeAdapterOptions {
  /** The user's repo root. Only used to place the cache. */
  projectRoot: string;
  /** Where the artifacts and derived data live. Default `<projectRoot>/.mobile-bisect/build`. */
  cacheDir?: string;
  /** Subdirectory of the worktree holding the project, e.g. `ios`. Default: detected. */
  projectDir?: string;
  /** `.xcworkspace` basename. Detected when omitted. */
  workspace?: string;
  /** `.xcodeproj` basename, used when there is no workspace. */
  project?: string;
  /** Required unless exactly one shared scheme exists. */
  scheme?: string;
  /** Default `Debug`: a Release build strips the symbols the diagnosis reads. */
  configuration?: string;
  sdk?: string;
  destination?: string;
  /** Per-candidate build budget. Default 30 minutes. */
  buildTimeoutMs?: number;
  /** Run `pod install` when a Podfile is present. Default true. */
  cocoapods?: boolean;
  /** Appended verbatim to every xcodebuild invocation. */
  extraArgs?: string[];
  xcodebuildPath?: string;
  /** Cached builds retained per configuration. Default 24. */
  cacheKeep?: number;
  onLog?: (line: string) => void;
  /** Injected in tests so the suite never spawns a compiler. */
  exec?: ExecFn;
}

const DEFAULT_CONFIGURATION = 'Debug';
const DEFAULT_SDK = 'iphonesimulator';
const DEFAULT_DESTINATION = 'generic/platform=iOS Simulator';
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;

export class XcodeAdapter implements FrameworkAdapter {
  readonly name = 'xcode';
  readonly displayName = 'Xcode (Swift / Objective-C)';
  readonly candidateKind = 'binary' as const;

  private readonly opts: XcodeAdapterOptions;
  private readonly exec: ExecFn;
  private readonly cache: BuildCache;
  private readonly builds = new Mutex();
  private readonly cacheDir: string;
  /** sha -> the key `prepare` actually used, so `noteUploaded` never guesses. */
  private readonly keys = new Map<string, CacheKey>();

  constructor(opts: XcodeAdapterOptions) {
    if (!opts?.projectRoot) throw new Error('XcodeAdapter requires a projectRoot');
    this.opts = opts;
    this.exec = opts.exec ?? execBuild;
    this.cacheDir = opts.cacheDir ?? path.join(opts.projectRoot, '.mobile-bisect', 'build');
    this.cache = new BuildCache(path.join(this.cacheDir, 'artifacts'));
  }

  // --- detection -----------------------------------------------------------

  async detect(projectPath: string): Promise<AdapterDetection> {
    const found = await detectXcodeProject(projectPath);
    if (!found) {
      return {
        ok: false,
        confidence: 0,
        platforms: [],
        reason: 'no .xcworkspace, .xcodeproj or Package.swift found',
      };
    }
    if (found.kind === 'swiftpm') {
      return {
        ok: false,
        confidence: 0.2,
        platforms: [],
        reason:
          'only a Package.swift was found. A Swift package has no app target to install, point --project-dir at the app that consumes it.',
      };
    }

    const scheme = this.opts.scheme ?? soleScheme(found);
    if (!scheme) {
      return {
        ok: false,
        confidence: 0.6,
        platforms: ['ios'],
        reason:
          found.schemes.length === 0
            ? `${found.container} has no shared schemes. Share one in Xcode (Product > Scheme > Manage Schemes) or set \`build.scheme\`.`
            : `${found.container} has ${found.schemes.length} shared schemes (${found.schemes.join(', ')}). Set \`build.scheme\` to pick one.`,
      };
    }

    return {
      ok: true,
      // Below Expo on purpose: a prebuilt Expo app has an ios/ directory too,
      // and swapping its JS beats rebuilding it.
      confidence: found.nested ? 0.55 : 0.8,
      platforms: ['ios'],
      summary: `${found.container}${found.dir ? ` in ${found.dir}/` : ''}, scheme ${scheme}`,
    };
  }

  // --- preparation ---------------------------------------------------------

  async prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate> {
    if (ctx.platform !== 'ios') {
      throw new CandidatePrepareError(`the Xcode adapter only builds iOS, not ${ctx.platform}`, {
        sha,
        adapter: this.name,
      });
    }

    const found = await this.resolveProject(worktreePath, sha);
    const scheme = this.opts.scheme ?? soleScheme(found);
    if (!scheme) {
      throw new CandidatePrepareError(
        `cannot tell which scheme to build (${found.schemes.join(', ') || 'none shared'}). Set \`build.scheme\`.`,
        { sha, adapter: this.name },
      );
    }

    const configuration = this.opts.configuration ?? DEFAULT_CONFIGURATION;
    const sdk = this.opts.sdk ?? DEFAULT_SDK;
    const key: CacheKey = {
      sha,
      platform: 'ios',
      params: { scheme, configuration, sdk },
    };
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
      // A queued candidate may have been built by the run ahead of it.
      const raced = await this.cache.get(key);
      if (raced) {
        return this.candidate(sha, worktreePath, raced.appPath, {
          bundleId: raced.bundleId,
          buildId: raced.buildId,
          cached: true,
          durationMs: 0,
        });
      }
      return this.build(sha, worktreePath, found, key, { scheme, configuration, sdk }, ctx);
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
    found: XcodeProject,
    key: CacheKey,
    cfg: { scheme: string; configuration: string; sdk: string },
    ctx: PrepareContext,
  ): Promise<PreparedCandidate> {
    const started = Date.now();
    const projectDir = path.join(worktreePath, found.dir);
    const derivedData = path.join(this.cacheDir, 'DerivedData', slugOf(cfg.scheme, cfg.configuration));
    await mkdir(derivedData, { recursive: true });

    if (found.hasPodfile && (this.opts.cocoapods ?? true)) {
      ctx.onLog?.(`[${short(sha)}] pod install`);
      const pods = await this.exec('pod', ['install'], {
        cwd: projectDir,
        timeoutMs: this.timeout(),
        signal: ctx.signal,
        onLine: (l) => this.log(ctx, sha, l),
      });
      if (!pods.ok) {
        throw new CandidatePrepareError(
          new BuildError(`pod install failed for ${short(sha)}`, pods).message,
          { sha, adapter: this.name },
        );
      }
    }

    const args = this.xcodebuildArgs(found, cfg, derivedData);
    ctx.onLog?.(`[${short(sha)}] xcodebuild ${cfg.scheme} (${cfg.configuration})`);
    const outcome = await this.exec(this.opts.xcodebuildPath ?? 'xcodebuild', args, {
      cwd: projectDir,
      timeoutMs: this.timeout(),
      signal: ctx.signal,
      onLine: (l) => this.log(ctx, sha, l),
    });
    if (!outcome.ok) {
      throw new CandidatePrepareError(
        new BuildError(`xcodebuild failed for ${short(sha)}`, outcome).message,
        { sha, adapter: this.name },
      );
    }

    const app = await findSimulatorApp(derivedData, cfg.configuration, cfg.sdk);
    if (!app) {
      throw new CandidatePrepareError(
        `xcodebuild succeeded for ${short(sha)} but no .app appeared under ${derivedData}/Build/Products. ` +
          `Is scheme "${cfg.scheme}" an app target rather than a library?`,
        { sha, adapter: this.name },
      );
    }

    const dir = await this.cache.stagingDir(key);
    const zipPath = path.join(dir, `${path.basename(app.path, '.app')}.app.zip`);
    await zipApp(app.path, zipPath, { exec: this.exec });
    const bundleId = await readBundleId(app.path, { exec: this.exec });

    const buildMs = Date.now() - started;
    await this.cache.put(key, {
      appPath: zipPath,
      bundleId,
      builtAt: new Date(started).toISOString(),
      buildMs,
    });
    await this.cache
      .prune({ platform: 'ios', params: key.params }, this.opts.cacheKeep ?? 24)
      .catch(() => []);

    ctx.onLog?.(`[${short(sha)}] built in ${Math.round(buildMs / 1000)}s -> ${path.basename(zipPath)}`);
    return this.candidate(sha, worktreePath, zipPath, { bundleId, durationMs: buildMs });
  }

  private xcodebuildArgs(
    found: XcodeProject,
    cfg: { scheme: string; configuration: string; sdk: string },
    derivedData: string,
  ): string[] {
    const args = ['build'];
    if (this.opts.workspace) args.push('-workspace', this.opts.workspace);
    else if (this.opts.project) args.push('-project', this.opts.project);
    else if (found.kind === 'workspace') args.push('-workspace', found.container);
    else args.push('-project', found.container);

    args.push(
      '-scheme',
      cfg.scheme,
      '-configuration',
      cfg.configuration,
      '-sdk',
      cfg.sdk,
      '-destination',
      this.opts.destination ?? DEFAULT_DESTINATION,
      '-derivedDataPath',
      derivedData,
      // A simulator build needs no identity, and asking for one on a machine
      // without the team's certificates fails for a reason unrelated to the bug.
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=',
    );
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    return args;
  }

  private async resolveProject(worktreePath: string, sha: string): Promise<XcodeProject> {
    const searchRoot = this.opts.projectDir
      ? path.join(worktreePath, this.opts.projectDir)
      : worktreePath;
    const found = await detectXcodeProject(searchRoot);
    if (!found) {
      throw new CandidatePrepareError(
        `no Xcode project under ${this.opts.projectDir ?? '.'} at ${short(sha)}`,
        { sha, adapter: this.name },
      );
    }
    // detect() searched relative to searchRoot; make dir relative to the worktree.
    return this.opts.projectDir
      ? { ...found, dir: path.join(this.opts.projectDir, found.dir) }
      : found;
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
      platform: 'ios',
      appPath,
      ...extra,
      // The artifact outlives the candidate on purpose: it is cached, and the
      // final comparison view wants the last-good build still on disk.
      dispose: async () => {},
    };
  }

  private timeout(): number {
    return this.opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  }

  private log(ctx: PrepareContext, sha: string, line: string): void {
    // xcodebuild prints thousands of lines; only what a human would read.
    if (!/(error|warning: .*deprecated|\*\* BUILD)/i.test(line)) return;
    const sink = ctx.onLog ?? this.opts.onLog;
    sink?.(`[${short(sha)}] ${line.trim()}`);
  }
}

function soleScheme(found: XcodeProject): string | undefined {
  return found.schemes.length === 1 ? found.schemes[0] : undefined;
}

function slugOf(scheme: string, configuration: string): string {
  return `${scheme}-${configuration}`.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
