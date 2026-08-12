/**
 * `MobileRuntimeRunner` over the Revyl CLI.
 *
 * Deliberately boring: every CLI fact lives in `cli-adapter.ts` and every
 * pass/fail/inconclusive judgement lives in `classify.ts`, so what remains here
 * is sequencing, start a device, point it at the candidate's JS, walk the
 * flow, ask the assertion, collect what the run produced.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type {
  Artifacts,
  LaunchInput,
  MobileRuntimeRunner,
  RunFlowInput,
  RunResult,
  Session,
  StartSessionInput,
  UploadBuildInput,
  UploadedBuild,
} from '@mobile-bisect/core';
import * as cli from './cli-adapter.js';
import { classify, isInfraFailure } from './classify.js';
import { downloadAll, type FetchLike } from './download.js';
import { RevylError, RevylInfraError } from './errors.js';
import {
  createExecutor,
  DEFAULT_COMMAND_TIMEOUT_MS,
  resolveRevylCli,
  type CliExecutor,
  type CliResult,
} from './exec.js';
import { redactWithEnv } from './redact.js';

export interface RevylRunnerOptions {
  appId?: string;
  buildId?: string;
  /** iOS only for v1; Android sessions start but are not yet exercised. */
  platform?: 'ios' | 'android';
  deviceModel?: string;
  osVersion?: string;
  /** Reuse one session across candidates instead of one session per commit. */
  reuseSession?: boolean;
  /** Budget for a whole `runFlow`, not for one CLI call. */
  timeoutMs?: number;
  /** Default: resolve `revyl` from PATH, then ~/.revyl/bin/revyl. */
  cliPath?: string;
  onLog?: (line: string) => void;

  // --- additive, all optional ---
  /** Needed only when a candidate is launched by bundle id rather than a deep link. */
  bundleId?: string;
  /**
   * Where `collectArtifacts` writes evidence. The CLI passes
   * `RunStore.artifactsDir`. When omitted the runner writes nothing to disk and
   * reports remote URLs only, so the package stays usable standalone.
   */
  artifactsDir?: string;
  /** What `localPaths` are relative to, per the `Artifacts` contract. Default: the parent of `artifactsDir`. */
  runDir?: string;
  /** Injected in tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Screenshot downloads in flight. Default 5. */
  downloadConcurrency?: number;
  /** Per-download budget so a hung fetch cannot wedge the search. Default 20s. */
  artifactTimeoutMs?: number;
  /** Budget for one `build upload`. A 200 MB simulator app is slow. Default 10 min. */
  uploadTimeoutMs?: number;
  /** Device idle timeout in seconds. Default 900. */
  idleTimeoutSec?: number;
  /**
   * After pointing the dev client at a candidate, check the screen is not a
   * bundler/JS error screen. A candidate whose bundle will not load must be
   * inconclusive, never `fail`. Set false to skip, or pass your own assertion.
   */
  bundleErrorCheck?: boolean | string;
  /** Milliseconds to let the bundle settle before the error-screen check. */
  bundleSettleMs?: number;
  /** Injected in tests so the suite never touches the cloud. */
  executor?: CliExecutor;
}

/**
 * What "this build never started" looks like on screen.
 *
 * Covers both halves: a JS candidate whose bundle will not load, and a native
 * candidate that built fine but cannot run standalone, which is what a
 * dev-client build does when there is no packager for it to find.
 */
const DEFAULT_BUNDLE_ERROR_ASSERTION =
  'The screen is showing a fatal loading error rather than the app itself: a red or white ' +
  'JavaScript error screen, a Metro bundler error, an "Unable to load script" or "No script ' +
  'URL provided" message, the Expo dev client "Something went wrong" screen, a development ' +
  'client waiting for or searching for a development server, or a blank or crashed screen';

interface SessionState {
  sessionId: string;
  index: number;
  workflowRunId?: string;
  viewerUrl?: string;
  deviceModel: string;
  osVersion: string;
  /** What the session was started for; decides how an uploaded build is tagged. */
  platform?: 'ios' | 'android';
}

interface RunState {
  sessionId: string;
  workflowRunId?: string;
  /** Frames decoded from the per-step envelopes, in execution order. */
  localScreenshots: string[];
  /** Raw `device logs --no-follow` output, taken before the session is stopped. */
  logsSnapshot?: string;
}

export class RevylRunner implements MobileRuntimeRunner {
  private readonly opts: RevylRunnerOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runs = new Map<string, RunState>();
  private executorPromise?: Promise<CliExecutor>;
  private reusable?: SessionState;
  private runSeq = 0;

  constructor(opts: RevylRunnerOptions = {}) {
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // MobileRuntimeRunner
  // -------------------------------------------------------------------------

  async startSession(input: StartSessionInput): Promise<Session> {
    const exec = await this.exec();

    if (input.sessionId) return this.attach(exec, input.sessionId, input);
    if (this.opts.reuseSession && this.reusable) return toSession(this.reusable);

    const platform = input.platform ?? this.opts.platform ?? 'ios';
    const deviceModel = input.deviceModel ?? this.opts.deviceModel;
    const osVersion = input.osVersion ?? this.opts.osVersion;

    const res = await exec(
      cli.deviceStartArgs({
        platform,
        ...(deviceModel ? { deviceModel } : {}),
        ...(osVersion ? { osVersion } : {}),
        ...(this.opts.buildId ? { buildId: this.opts.buildId } : {}),
        ...(this.opts.appId ? { appId: this.opts.appId } : {}),
        idleTimeoutSec: this.opts.idleTimeoutSec ?? 900,
      }),
      { timeoutMs: Math.max(this.opts.timeoutMs ?? 0, 300_000) },
    );

    const info = cli.parseSessionInfo(res);
    if (!info) throw infraFrom(res, 'session-start', 'Could not start a cloud device session');

    // `device start` echoes neither model nor runtime, so record what we asked
    // for and let `device report` correct it later if the pool substituted.
    const state: SessionState = {
      sessionId: info.sessionId,
      index: info.index,
      ...(info.workflowRunId ? { workflowRunId: info.workflowRunId } : {}),
      ...(info.viewerUrl ? { viewerUrl: info.viewerUrl } : {}),
      deviceModel: deviceModel ?? 'unknown',
      osVersion: osVersion ?? 'unknown',
      platform,
    };
    this.sessions.set(state.sessionId, state);
    if (this.opts.reuseSession) this.reusable = state;
    return toSession(state);
  }

  /**
   * Registers a locally built artifact and returns the id that installs it.
   *
   * The native adapters compile a binary per candidate; this is where that
   * binary becomes something a cloud device can run. Bundle-swapping adapters
   * never call it.
   */
  async uploadBuild(input: UploadBuildInput): Promise<UploadedBuild> {
    const exec = await this.exec();
    const res = await exec(
      cli.buildUploadArgs({
        filePath: input.appPath,
        platform: input.platform,
        ...(this.opts.appId ? { appId: this.opts.appId } : {}),
        ...(input.version ? { version: input.version } : {}),
      }),
      { timeoutMs: this.opts.uploadTimeoutMs ?? 600_000 },
    );
    if (res.code !== 0) {
      throw infraFrom(res, 'build-upload', 'Could not upload the candidate build to Revyl');
    }

    const parsed = cli.parseUploadedBuild(res);
    if (!parsed) {
      throw infraFrom(
        res,
        'build-upload',
        'Revyl accepted the build but returned no build id, so it cannot be installed',
      );
    }
    this.opts.onLog?.(`uploaded ${input.version ?? input.appPath} -> build ${parsed.buildId}`);
    return parsed;
  }

  /**
   * Build versions this app already has.
   *
   * Used before the search starts, to find commits that can be tested by
   * installing rather than compiling.
   */
  async listBuilds(): Promise<Array<{ buildId: string; version: string }>> {
    const exec = await this.exec();
    const res = await exec(cli.buildListArgs(this.opts.appId), { timeoutMs: 60_000 });
    // An empty list and a failed call mean opposite things: one says the app
    // has no builds, the other says we never found out. Reporting the second
    // as the first is how an optimisation silently stops running.
    if (res.code !== 0) throw infraFrom(res, 'build-list', 'Could not list the app\'s builds');
    return cli.parseBuildList(res);
  }

  async installOrLaunch(input: LaunchInput): Promise<void> {
    const exec = await this.exec();
    const state = await this.requireSession(exec, input.sessionId);
    const target = { index: state.index };

    // A caller that hands over a raw artifact gets it uploaded first: without
    // an id there is nothing for `device install` to reference.
    let uploaded: string | undefined;
    if (!input.buildId && input.appPath) {
      const built = await this.uploadBuild({
        appPath: input.appPath,
        platform: state.platform ?? this.opts.platform ?? 'ios',
        ...(input.buildId ? { version: input.buildId } : {}),
      });
      uploaded = built.buildId;
    }

    const buildId = input.buildId ?? uploaded ?? this.opts.buildId;
    const bundleId = input.bundleId ?? this.opts.bundleId;
    if (buildId || this.opts.appId) {
      const res = await retryTransient(() =>
        exec(
          cli.deviceInstallArgs(
            {
              ...(buildId ? { buildId } : {}),
              ...(this.opts.appId ? { appId: this.opts.appId } : {}),
              ...(bundleId ? { bundleId } : {}),
            },
            target,
          ),
          { timeoutMs: 300_000 },
        ),
      );
      if (res.code !== 0) throw infraFrom(res, 'install', 'Could not install the app on the cloud device');
    }

    if (input.resetState) {
      // Best effort: the CLI exposes no container wipe, so this only guarantees
      // a cold JS start. See README "Known gaps".
      await exec(cli.deviceKillAppArgs(target), { timeoutMs: 60_000 });
    }

    if (input.bundleUrl) {
      const res = await exec(cli.deviceNavigateArgs(input.bundleUrl, target), { timeoutMs: 120_000 });
      if (res.code !== 0) {
        throw infraFrom(res, 'bundle-load', 'Could not point the dev client at the candidate bundle');
      }
    } else if (bundleId) {
      const res = await exec(cli.deviceLaunchArgs(bundleId, target), { timeoutMs: 120_000 });
      if (res.code !== 0) throw infraFrom(res, 'launch', 'Could not launch the app');
    }

    // Every candidate, not just the JS ones. A compiled binary reaches this
    // point having built successfully and can still be unrunnable: a dev
    // client with no packager to reach, a launch crash, a blank screen. The
    // flow would then fail its assertion and the commit would be recorded
    // `bad`, which is a confident wrong answer about a commit that never ran.
    await this.assertBundleLoaded(exec, target);
  }

  async runFlow(input: RunFlowInput): Promise<RunResult> {
    const started = Date.now();
    const budget = input.timeoutMs ?? this.opts.timeoutMs;
    const deadline = budget ? started + budget : undefined;
    const remaining = (): number =>
      deadline ? Math.max(1_000, deadline - Date.now()) : DEFAULT_COMMAND_TIMEOUT_MS;

    const exec = await this.exec();
    const state = await this.requireSession(exec, input.sessionId);
    const target = { index: state.index };

    const run: RunState = {
      sessionId: state.sessionId,
      ...(state.workflowRunId ? { workflowRunId: state.workflowRunId } : {}),
      localScreenshots: [],
    };
    const runId = state.workflowRunId ?? `${state.sessionId}-${++this.runSeq}`;
    this.runs.set(runId, run);

    const steps = input.flow.steps ?? [];
    let stepsCompleted = 0;
    let failedAction: { outcome: cli.StepOutcome; label: string } | undefined;
    let infraReason: string | undefined;
    let assertionOutcome: cli.StepOutcome | undefined;

    for (const [i, step] of steps.entries()) {
      const label = step.label ?? `Step ${i + 1}`;
      input.onStep?.(i + 1, label);

      let outcome: cli.StepOutcome;
      try {
        const { argv } = cli.stepArgs(step, target);
        outcome = cli.parseStepOutcome(await exec(argv, { timeoutMs: remaining() }));
      } catch (err) {
        // A flow this adapter cannot express is a harness problem, not a
        // statement about the commit.
        infraReason = err instanceof Error ? err.message : String(err);
        break;
      }

      const frame = await this.captureFrame(run, runId, outcome, i + 1);
      if (frame) input.onFrame?.(i + 1, frame);
      run.workflowRunId ??= outcome.workflowRunId;

      if (outcome.code === 0) {
        stepsCompleted += 1;
        continue;
      }
      if (isInfraFailure(outcome)) {
        infraReason = outcome.stderr || outcome.spawnError || `Step "${label}" failed on the device`;
        break;
      }
      // The step ran but the agent could not complete it. Stop burning device
      // time on the rest of the flow and go ask the assertion, which is the
      // only ground truth we trust.
      failedAction = { outcome, label };
      break;
    }

    if (!infraReason) {
      const res = await exec(cli.deviceValidationArgs(input.assertion, target), { timeoutMs: remaining() });
      assertionOutcome = cli.parseStepOutcome(res);
      const frame = await this.captureFrame(run, runId, assertionOutcome, steps.length + 1);
      if (frame) input.onFrame?.(steps.length + 1, frame);
      run.workflowRunId ??= assertionOutcome.workflowRunId;
    }

    // Snapshot logs while the session is still alive; they are unreachable once
    // it stops, and `revyl run logs` does not accept a device session id.
    const logs = await exec(cli.deviceLogsArgs(target), { timeoutMs: 60_000 });
    if (logs.code === 0 && logs.stdout.trim()) run.logsSnapshot = redactWithEnv(logs.stdout);

    const { verdict, reason } = classify({
      ...(assertionOutcome ? { assertion: assertionOutcome } : {}),
      ...(failedAction ? { failedAction } : {}),
      ...(infraReason ? { infraReason } : {}),
      stepsCompleted,
    });

    return {
      runId,
      verdict,
      reason: redactWithEnv(reason),
      durationMs: Date.now() - started,
      stepsCompleted,
    };
  }

  /**
   * Evidence gathering, and nothing here can change a verdict.
   *
   * The screenshots are downloaded *eagerly*, not left as links for the report
   * to fetch later: they are presigned and expire (`X-Amz-Expires=3600` on the
   * frames we recorded), and a six-round bisect with retries can easily outlive
   * that, which would leave the earliest rounds, often the interesting ones -
   * with dead evidence. Every failure here is logged and skipped.
   */
  async collectArtifacts(runId: string): Promise<Artifacts> {
    const exec = await this.exec();
    const run = this.runs.get(runId);
    const sessionId = run?.sessionId ?? runId;

    const artifacts: Artifacts = {};
    const dir = await this.artifactsDirFor(runId);
    const localPaths: string[] = [];

    const report = cli.parseSessionReport(
      await exec(cli.deviceReportArgs({ sessionId }), { timeoutMs: 120_000 }),
    );
    const frames = report?.frames ?? [];
    // Keep the remote URLs for the live view *and* pull copies for the report.
    // There is no recording URL on this surface, so `videoUrl` stays unset.
    if (frames.length) artifacts.screenshots = frames.map((f) => f.url);

    if (dir) {
      const outcomes = await downloadAll(
        frames.map((f) => ({ url: f.url, destPath: join(dir, cli.frameFilename(f)) })),
        {
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
          concurrency: this.opts.downloadConcurrency ?? 5,
          timeoutMs: this.opts.artifactTimeoutMs ?? 20_000,
          ...(this.opts.onLog ? { onLog: (l) => this.opts.onLog!(redactWithEnv(l)) } : {}),
        },
      );
      for (const o of outcomes) if (o.ok) localPaths.push(o.destPath);

      localPaths.push(...(run?.localScreenshots ?? []));

      for (const [artifact, filename] of [
        ['network', 'network_requests.json.gz'],
        ['trace', 'perfetto_trace.perfetto-trace.gz'],
        ['perf', 'hardware_metrics.json.gz'],
      ] as const) {
        const out = join(dir, filename);
        const res = await exec(cli.deviceReportArgs({ sessionId, artifact, download: true, output: out }), {
          timeoutMs: 180_000,
        });
        if (res.code === 0) localPaths.push(out);
      }

      // Device logs are session-scoped and only readable while the session
      // lives, so `runFlow` snapshots them; here we only persist what it caught.
      if (run?.logsSnapshot) {
        const out = join(dir, 'device_logs.json');
        try {
          await writeFile(out, run.logsSnapshot);
          localPaths.push(out);
        } catch (err) {
          this.opts.onLog?.(redactWithEnv(`could not write device logs: ${String(err)}`));
        }
      }
    }

    const relPaths = localPaths.map((p) => this.toRunRelative(p));
    if (relPaths.length) artifacts.localPaths = relPaths;
    // With no remote frames, the locally captured ones are all the report has.
    if (!artifacts.screenshots?.length) {
      const pngs = relPaths.filter((p) => p.endsWith('.png'));
      if (pngs.length) artifacts.screenshots = pngs;
    }
    return artifacts;
  }

  async stopSession(sessionId: string): Promise<void> {
    const exec = await this.exec();
    const state = this.sessions.get(sessionId);
    if (this.opts.reuseSession && this.reusable?.sessionId === sessionId) return;

    const index = state?.index ?? (await this.lookupIndex(exec, sessionId));
    if (index === undefined) return; // already gone
    await exec(cli.deviceStopArgs({ index }), { timeoutMs: 120_000 });
    this.sessions.delete(sessionId);
  }

  /** Stop the shared session opened by `reuseSession`. Call once at the end. */
  async dispose(): Promise<void> {
    const shared = this.reusable;
    this.reusable = undefined;
    if (shared) await this.stopSession(shared.sessionId);
    for (const id of [...this.sessions.keys()]) await this.stopSession(id);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async exec(): Promise<CliExecutor> {
    if (this.opts.executor) return this.opts.executor;
    this.executorPromise ??= (async () => {
      const cliPath = await resolveRevylCli(this.opts.cliPath);
      return createExecutor({
        cliPath,
        ...(this.opts.onLog ? { onLog: this.opts.onLog } : {}),
      });
    })();
    return await this.executorPromise;
  }

  private async attach(exec: CliExecutor, sessionId: string, input: StartSessionInput): Promise<Session> {
    const index = await this.lookupIndex(exec, sessionId);
    if (index === undefined) {
      throw new RevylInfraError(`Device session ${sessionId} is no longer running.`, { stage: 'attach' });
    }
    const state: SessionState = {
      sessionId,
      index,
      deviceModel: input.deviceModel ?? this.opts.deviceModel ?? 'unknown',
      osVersion: input.osVersion ?? this.opts.osVersion ?? 'unknown',
    };
    const info = cli.parseSessionInfo(await exec(cli.deviceInfoArgs({ index })));
    if (info?.workflowRunId) state.workflowRunId = info.workflowRunId;
    if (info?.viewerUrl) state.viewerUrl = info.viewerUrl;
    this.sessions.set(sessionId, state);
    if (this.opts.reuseSession) this.reusable = state;
    return toSession(state);
  }

  /**
   * `revyl device …` targets sessions by *index*, and indices shift as sessions
   * come and go, under `--concurrency 4` a stale index would drive the wrong
   * device. Re-resolve from the session id before each phase.
   */
  private async requireSession(exec: CliExecutor, sessionId: string): Promise<SessionState> {
    const index = await this.lookupIndex(exec, sessionId);
    if (index === undefined) {
      throw new RevylInfraError(`Device session ${sessionId} is no longer running.`, { stage: 'session-lost' });
    }
    const state = this.sessions.get(sessionId) ?? {
      sessionId,
      index,
      deviceModel: this.opts.deviceModel ?? 'unknown',
      osVersion: this.opts.osVersion ?? 'unknown',
    };
    state.index = index;
    this.sessions.set(sessionId, state);
    return state;
  }

  private async lookupIndex(exec: CliExecutor, sessionId: string): Promise<number | undefined> {
    const list = cli.parseSessionList(await exec(cli.deviceListArgs(), { timeoutMs: 60_000 }));
    return list.find((s) => s.sessionId === sessionId)?.index;
  }

  private async assertBundleLoaded(exec: CliExecutor, target: { index: number }): Promise<void> {
    const check = this.opts.bundleErrorCheck ?? true;
    if (check === false) return;
    const assertion = typeof check === 'string' ? check : DEFAULT_BUNDLE_ERROR_ASSERTION;

    const settle = this.opts.bundleSettleMs ?? 4_000;
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));

    const res = await exec(cli.deviceValidationArgs(assertion, target), { timeoutMs: 120_000 });
    const outcome = cli.parseStepOutcome(res);
    if (isInfraFailure(outcome)) {
      throw infraFrom(res, 'bundle-load', 'Could not confirm the candidate bundle loaded');
    }
    // The assertion is phrased positively about the *error* screen, so a true
    // result means the bundle did not load.
    if (outcome.validationResult === true) {
      throw new RevylInfraError(
        `The candidate bundle did not load: ${outcome.reasoning ?? 'the device is showing a bundler error screen'}`,
        { stage: 'bundle-load' },
      );
    }
  }

  /** `undefined` means "no artifactsDir configured", stay URL-only, touch no disk. */
  private async artifactsDirFor(runId: string): Promise<string | undefined> {
    const base = this.opts.artifactsDir;
    if (!base) return undefined;
    const dir = join(base, runId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * `Artifacts.localPaths` is defined as relative to the run dir, so the report
   * stays portable if a run directory is moved or zipped up for a bug report.
   */
  private toRunRelative(absolute: string): string {
    const root = this.opts.runDir ?? (this.opts.artifactsDir ? dirname(this.opts.artifactsDir) : undefined);
    if (!root) return absolute;
    return relative(root, absolute).split(sep).join('/');
  }

  /** Step envelopes carry a base64 PNG; persist it so the report has frames. */
  private async captureFrame(
    run: RunState,
    runId: string,
    outcome: cli.StepOutcome,
    ordinal: number,
  ): Promise<string | undefined> {
    if (!outcome.imageBase64) return undefined;
    try {
      const dir = await this.artifactsDirFor(runId);
      if (!dir) return undefined;
      const path = join(dir, `step-${String(ordinal).padStart(2, '0')}-live.png`);
      await writeFile(path, Buffer.from(outcome.imageBase64, 'base64'));
      run.localScreenshots.push(path);
      // Run-relative, matching `Artifacts.localPaths`, so a caller can hand it
      // straight to the report without knowing where the run dir lives.
      return this.toRunRelative(path);
    } catch (err) {
      this.opts.onLog?.(redactWithEnv(`could not write step frame: ${String(err)}`));
      return undefined;
    }
  }
}

function toSession(state: SessionState): Session {
  return {
    sessionId: state.sessionId,
    deviceModel: state.deviceModel,
    osVersion: state.osVersion,
    ...(state.viewerUrl ? { streamUrl: state.viewerUrl } : {}),
  };
}

/**
 * A device that has only just started can answer `/install` with a 503 while its
 * worker is still connecting; the CLI's own message says to wait and retry. One
 * such blip used to cost the whole build pass, which then fell back to
 * compiling every candidate.
 */
export function isTransientDeviceFailure(res: CliResult): boolean {
  if (res.code === 0) return false;
  const text = `${res.stderr} ${res.stdout}`;
  return /\b50[234]\b|not be fully connected|not fully connected|temporarily unavailable|connection reset|ECONNRESET|EAI_AGAIN/i.test(
    text,
  );
}

export async function retryTransient(
  run: () => Promise<CliResult>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<CliResult> {
  const attempts = opts.attempts ?? 3;
  const base = opts.delayMs ?? 3_000;
  let res = await run();
  for (let attempt = 1; attempt < attempts && isTransientDeviceFailure(res); attempt++) {
    await new Promise((r) => setTimeout(r, base * attempt));
    res = await run();
  }
  return res;
}

function infraFrom(res: CliResult, stage: string, summary: string): RevylError {
  const detail = res.stderr.trim() || res.spawnError || `exit ${res.code}`;
  return new RevylInfraError(`${summary}: ${detail}`, { stage, exitCode: res.code });
}
