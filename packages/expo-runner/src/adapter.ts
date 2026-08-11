/**
 * The Expo adapter: the fast path.
 *
 * Every other framework compiles per candidate. Expo does not have to, the
 * device is already running a dev client, so a candidate is a URL, not a build,
 * and a round costs seconds instead of minutes. `ExpoCandidateRunner` does the
 * work; this class is the contract face over it, plus the precheck that refuses
 * a range where the shortcut would quietly test the wrong binary.
 */

import {
  CandidatePrepareError,
  type AdapterDetection,
  type FrameworkAdapter,
  type PrecheckInput,
  type PrecheckResult,
  type PrepareContext,
  type PreparedCandidate,
} from '@mobile-bisect/core';
import { detectExpoProject } from './detect.js';
import { detectNativeChangeFromGit, formatNativeChangeMessage } from './native-change.js';
import { ExpoCandidateRunner, type ExpoCandidateRunnerOptions } from './runner.js';

export interface ExpoAdapterOptions extends ExpoCandidateRunnerOptions {
  /**
   * Refuse a range whose diff touches native code. Default true, with it off
   * the search still runs, but a native-change commit may be misclassified.
   */
  rejectNativeChanges?: boolean;
}

export class ExpoAdapter implements FrameworkAdapter {
  readonly name = 'expo';
  readonly displayName = 'Expo';
  readonly candidateKind = 'bundle' as const;

  private readonly runner: ExpoCandidateRunner;
  private readonly opts: ExpoAdapterOptions;

  constructor(opts: ExpoAdapterOptions) {
    this.opts = opts;
    this.runner = new ExpoCandidateRunner(opts);
  }

  async detect(projectPath: string): Promise<AdapterDetection> {
    const info = await detectExpoProject(projectPath);
    if (!info.ok) {
      return { ok: false, confidence: 0, platforms: [], reason: info.reason };
    }
    return {
      ok: true,
      // Highest of any adapter: a prebuilt Expo app also has ios/ and android/
      // directories, and swapping its JS beats rebuilding either of them.
      confidence: 0.95,
      platforms: ['ios', 'android'],
      summary: info.sdkVersion
        ? `Expo SDK ${info.sdkVersion}${info.usesRouter ? ' with expo-router' : ''}`
        : 'Expo project',
    };
  }

  /**
   * A native change invalidates the whole premise, so it is caught once up
   * front rather than per candidate, the answer would be confidently wrong,
   * which is worse than no answer.
   */
  async precheck(input: PrecheckInput): Promise<PrecheckResult> {
    if (this.opts.rejectNativeChanges === false) return { ok: true };

    const report = await detectNativeChangeFromGit(input.projectPath, input.goodSha, input.badSha);
    if (!report.native) return { ok: true };

    return {
      ok: false,
      reason: formatNativeChangeMessage(report, input.goodSha, input.badSha),
    };
  }

  async prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate> {
    const started = Date.now();
    try {
      const prep = await this.runner.prepare(worktreePath, sha);
      return {
        kind: 'bundle',
        sha,
        worktreePath,
        platform: ctx.platform,
        bundleUrl: prep.bundleUrl,
        durationMs: Date.now() - started,
        dispose: () => prep.dispose(),
      };
    } catch (err) {
      throw new CandidatePrepareError(err instanceof Error ? err.message : String(err), {
        sha,
        adapter: this.name,
        cause: err,
      });
    }
  }

  async dispose(): Promise<void> {
    await this.runner.dispose();
  }
}
