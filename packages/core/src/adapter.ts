/**
 * The framework adapter contract.
 *
 * The bisection engine only ever asks one question: *make this commit runnable
 * on a device.* How that happens, swapping a JavaScript bundle, compiling a
 * Swift target, assembling a Gradle variant, is the adapter's business and
 * nothing else's. `core` therefore knows about two kinds of answer and no
 * frameworks at all:
 *
 *   bundle  the device already has a native binary; hand it a URL
 *   binary  the commit produced an installable artifact; upload and install it
 *
 * Adapters live in their own packages and are loaded lazily by the CLI, so a
 * repo that never touches Xcode never pays for the Xcode adapter.
 */

import type { Platform } from './types.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface AdapterDetection {
  /** Whether this adapter can prepare candidates for the project. */
  ok: boolean;
  /** Why not, phrased for a terminal. Only meaningful when `ok` is false. */
  reason?: string;
  /**
   * How sure the adapter is, 0..1. Detection runs every adapter and picks the
   * highest score, so an Expo app, which also has `ios/` once prebuilt, is
   * claimed by the Expo adapter rather than by Xcode.
   */
  confidence: number;
  /** Platforms this project can actually be bisected on. */
  platforms: Platform[];
  /** One line for `init` output, e.g. "Xcode workspace Orbit.xcworkspace, scheme Orbit". */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export type CandidateKind = 'bundle' | 'binary';

/**
 * One commit, made runnable. Exactly one of `bundleUrl` / `appPath` is
 * populated, matching `kind`.
 */
export interface PreparedCandidate {
  kind: CandidateKind;
  sha: string;
  worktreePath: string;
  platform: Platform;
  /** `kind: 'bundle'`, dev-client deep link or packager URL for the device to open. */
  bundleUrl?: string;
  /** `kind: 'binary'`, local path to an installable .app.zip / .apk / .ipa. */
  appPath?: string;
  /** Set once the runtime has ingested `appPath`; lets a cached build skip re-upload. */
  buildId?: string;
  /** Needed to launch and to kill the app between candidates. */
  bundleId?: string;
  /** True when `prepare` served this from cache rather than building it. */
  cached?: boolean;
  /** How long preparation took, for the "6 runs, 4m 21s" line. */
  durationMs?: number;
  /** Release ports, stop servers, drop temp dirs. Always called, exactly once. */
  dispose(): Promise<void>;
}

export interface PrepareContext {
  platform: Platform;
  /** Streamed to the live view; already redacted by the caller's sink. */
  onLog?: (line: string) => void;
  /** Aborted when the user hits Ctrl-C mid-build. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Precheck
// ---------------------------------------------------------------------------

/**
 * Asked once, before any device is started. This is where an adapter refuses a
 * range it cannot answer honestly, the Expo adapter rejects a diff that
 * touches native code, because a JS swap would silently test the wrong binary.
 */
export interface PrecheckInput {
  projectPath: string;
  goodSha: string;
  badSha: string;
  platform: Platform;
}

export interface PrecheckResult {
  ok: boolean;
  /** Shown verbatim when `ok` is false. Should say what to do instead. */
  reason?: string;
  /** Shown but not fatal, e.g. "42 of 64 commits change native code, expect slow rounds." */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface FrameworkAdapter {
  /** Stable id used by `--framework` and in the config. */
  readonly name: string;
  /** For humans: "Expo", "Xcode (Swift/Objective-C)", "Gradle (Kotlin/Java)". */
  readonly displayName: string;
  /** What a candidate will look like, so the CLI can warn about cost up front. */
  readonly candidateKind: CandidateKind;

  detect(projectPath: string): Promise<AdapterDetection>;
  precheck?(input: PrecheckInput): Promise<PrecheckResult>;
  prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate>;
  /**
   * Optional: the runtime has ingested this candidate's artifact and given it
   * an id. Adapters that cache builds record it, so a resumed run installs the
   * same binary instead of rebuilding and re-uploading it.
   */
  noteUploaded?(sha: string, buildId: string, platform: Platform): Promise<void>;
  /** Tear down anything shared across candidates. Called once, at the end. */
  dispose?(): Promise<void>;
}

/** Thrown by `prepare` when a commit cannot be made runnable: skip, never blame. */
export class CandidatePrepareError extends Error {
  readonly sha: string;
  readonly adapter: string;

  constructor(message: string, opts: { sha: string; adapter: string; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CandidatePrepareError';
    this.sha = opts.sha;
    this.adapter = opts.adapter;
  }
}
