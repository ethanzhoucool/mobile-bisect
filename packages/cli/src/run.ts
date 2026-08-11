/**
 * Orchestration: refs → candidates → run store → bisector → device runs →
 * culprit → diff → diagnosis → report.
 *
 * The loop mirrors `drive()` in @mobile-bisect/core's test helpers, because the
 * Bisector owns strict invariants: exactly one candidate is active at a time,
 * `markRunning`/`step`/`record` must name that candidate, and an inconclusive
 * result keeps it active for the retry. Two rules of our own shape the rest:
 *   1. The user's working tree is never touched, every candidate is checked
 *      out into a detached worktree and removed afterwards.
 *   2. Every event is scrubbed before it reaches disk, the terminal or the
 *      report, so a run directory can be attached to a bug report as-is.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import {
  Bisector,
  FakeRunner,
  RetryPolicy,
  RunStore,
  diagnose,
  type BisectEvent,
  type BisectMeta,
  type BisectState,
  type CommitResult,
  type CommitSummary,
  type FlowDefinition,
  type FrameworkAdapter,
  type MobileRuntimeRunner,
  type PreparedCandidate,
  type Session,
} from '@mobile-bisect/core';
import * as git from '@mobile-bisect/git';
import { asBuildLister, loadReport, loadRunner } from './adapters.js';
import type { FrameworkName, ResumeOptions, RunOptions } from './args.js';
import { loadConfig, type MobileBisectConfig } from './config.js';
import { createFakeAdapter, resolveAdapter } from './frameworks.js';
import {
  appIdFromRevylConfig,
  buildChain,
  narrowByBuilds,
  narrowedRange,
  resolveBuildCommits,
} from './prebuilt.js';
import { CliError, messageOf } from './errors.js';
import { findFlowFile, loadFlow } from './flow.js';
import { redactDeep } from './redact.js';
import { LiveSink } from './ui/live.js';
import { JsonSink, PlainSink } from './ui/plain.js';
import { fanout, type EventSink } from './ui/sink.js';

const TOOL_DIR = '.mobile-bisect';

interface RunSidecar {
  version: 1;
  flowPath?: string;
  flow: FlowDefinition;
  expect: string;
  platform: 'ios' | 'android';
  deviceModel?: string;
  osVersion?: string;
  timeoutMs: number;
  concurrency: number;
  dryRun: boolean;
  culpritSha?: string;
  flakySha?: string;
  stepDelayMs: number;
  appId?: string;
  buildId?: string;
  /** Which adapter prepared the candidates, so `resume` uses the same one. */
  framework?: FrameworkName;
  command: string;
}

interface Ui {
  handle(e: BisectEvent): void;
  note(text: string): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function runCommand(opts: RunOptions): Promise<number> {
  const repo = path.resolve(opts.cwd);

  if (!(await git.isGitRepo(repo))) {
    throw new CliError(`\`${repo}\` is not a git repository.`, {
      hint: 'mobile-bisect walks git history, so run it inside your app repo (or pass --cwd).',
    });
  }

  if (!opts.allowDirty) {
    try {
      await git.assertCleanWorktree(repo);
    } catch (e) {
      throw new CliError(messageOf(e), {
        hint:
          'mobile-bisect never modifies or discards uncommitted work. Commit or stash it, or pass ' +
          '--allow-dirty to leave it exactly where it is while candidates run in detached worktrees.',
      });
    }
  }
  await ensureToolDirIgnored(repo);

  const { config } = await loadConfig(repo);
  const flowPath = await resolveFlowPath(repo, opts.flow ?? config.flow, opts.dryRun);
  const flow = flowPath ? await loadFlow(flowPath) : syntheticFlow();
  const expect = opts.expect ?? flow.expect ?? config.expect;
  if (!expect) {
    throw new CliError('No assertion to check.', {
      hint: 'Pass --expect "the order confirmation screen appears", or add an `expect:` line to the flow.',
      exitCode: 2,
    });
  }

  let commits = await enumerateCommits(repo, opts, config);

  // Before anything is compiled, test the builds this app already has. It only
  // pays off for adapters that compile, and it needs the range to survive into
  // `meta`, so it runs ahead of the run store.
  if (opts.prebuilt && !opts.dryRun) {
    commits = await narrowByExistingBuilds({ repo, commits, flow, expect, opts, config });
  }

  const meta = buildMeta({ opts, flow, flowPath, expect, commits, repo });

  const store = await RunStore.create(repo, meta.runId);
  const ui = await openUi(opts, store, { port: opts.port, open: opts.open });

  const runner = await buildRunner({ opts, commits, flow, config, store });
  const framework = await buildAdapter({ opts, config, repo, commits, ui });

  const sidecar: RunSidecar = {
    version: 1,
    flowPath: flowPath ? path.relative(repo, flowPath) : undefined,
    flow,
    expect,
    platform: opts.platform,
    deviceModel: opts.deviceModel ?? config.deviceModel,
    osVersion: opts.osVersion ?? config.osVersion,
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    culpritSha: runner.culpritSha,
    flakySha: runner.flakySha,
    stepDelayMs: opts.stepDelayMs,
    appId: flow.appId ?? config.appId,
    buildId: config.build?.buildId,
    framework: framework.name,
    command: meta.command,
  };
  await writeFile(
    path.join(store.dir, 'run.json'),
    `${JSON.stringify(redactDeep(sidecar), null, 2)}\n`,
    'utf8',
  );

  const engine = new BisectRun({
    repo,
    store,
    ui,
    flow,
    runner: runner.runner,
    adapter: framework.adapter,
    sidecar,
  });
  return engine.start(commits, meta);
}

/**
 * Narrows the range using builds Revyl already has, before anything compiles.
 *
 * Every test here is an install rather than a compile, so the pass is close to
 * free, and what it hands back is a smaller range for the real search. It is
 * strictly an optimisation: any failure, any missing app id, any set of build
 * labels that name no commits, and the full range goes through unchanged.
 */
async function narrowByExistingBuilds(input: {
  repo: string;
  commits: CommitSummary[];
  flow: FlowDefinition;
  expect: string;
  opts: RunOptions;
  config: MobileBisectConfig;
}): Promise<CommitSummary[]> {
  const { repo, commits, flow, expect, opts, config } = input;
  const appId =
    flow.appId ?? config.appId ?? (await appIdFromRevylConfig(repo, opts.platform));
  const note = (line: string): void => {
    process.stdout.write(`${pc.dim(line)}\n`);
  };

  let runner: MobileRuntimeRunner | undefined;
  try {
    const api = await loadRunner();
    runner = api.createRevylRunner({
      platform: opts.platform,
      deviceModel: opts.deviceModel ?? config.deviceModel,
      osVersion: opts.osVersion ?? config.osVersion,
      ...(appId ? { appId } : {}),
      projectRoot: repo,
      timeoutMs: opts.timeoutMs,
      flow,
    });

    const lister = asBuildLister(runner);
    if (!lister) return commits;

    if (!appId) {
      note('  no app id, so existing builds cannot be listed; compiling every candidate');
      note('  set `appId` in mobile-bisect.config.ts, or `build.app_id` in .revyl/config.yaml');
      return commits;
    }

    const builds = await lister.listBuilds();
    if (builds.length === 0) {
      note('  this app has no builds yet, compiling every candidate');
      return commits;
    }

    const prebuilt = await resolveBuildCommits(repo, builds, commits);
    const chain = buildChain(commits, prebuilt);
    if (!chain) {
      note(`  no existing build names a commit in this range, compiling every candidate`);
      return commits;
    }

    const interior = chain.length - 2;
    note(
      `  ${interior} of ${commits.length} commits already have a build; testing those first ` +
        `(install, not compile)`,
    );

    const result = await narrowByBuilds({
      chain,
      onNote: (l) => note(l),
      test: async (entry) => {
        const session = await runner!.startSession({
          platform: opts.platform,
          deviceModel: opts.deviceModel ?? config.deviceModel,
          osVersion: opts.osVersion ?? config.osVersion,
        });
        try {
          note(`  ${entry.commit.shortSha}  installing build ${entry.version}`);
          await runner!.installOrLaunch({
            sessionId: session.sessionId,
            buildId: entry.buildId,
            resetState: true,
          });
          const run = await runner!.runFlow({
            sessionId: session.sessionId,
            flow,
            assertion: expect,
            timeoutMs: opts.timeoutMs,
          });
          const verdict = run.verdict === 'pass' ? 'good' : run.verdict === 'fail' ? 'bad' : 'skip';
          note(`  ${entry.commit.shortSha}  ${verdict}`);
          return verdict;
        } finally {
          await runner!.stopSession(session.sessionId).catch(() => {});
        }
      },
    });

    const narrowed = narrowedRange(commits, result.goodSha, result.badSha);
    if (narrowed.length < commits.length) {
      note(
        `  builds narrowed ${commits.length} commits to ${narrowed.length} in ${result.tested} ` +
          `install${result.tested === 1 ? '' : 's'}, with nothing compiled`,
      );
    }
    return narrowed;
  } catch (e) {
    // An optimisation that fails is not a reason to abandon the search.
    note(`  could not use existing builds (${messageOf(e)}), compiling every candidate`);
    return commits;
  }
}

/**
 * Chooses the adapter and lets it veto the range before a device is started.
 *
 * The precheck is where an adapter refuses work it cannot answer honestly -
 * the Expo adapter rejects a range containing native changes, because swapping
 * JavaScript underneath the wrong binary produces a confident wrong answer.
 */
async function buildAdapter(input: {
  opts: RunOptions;
  config: MobileBisectConfig;
  repo: string;
  commits: CommitSummary[];
  ui: Ui;
}): Promise<{ name?: FrameworkName; adapter: FrameworkAdapter }> {
  const { opts, config, repo, commits, ui } = input;

  if (opts.dryRun) return { adapter: createFakeAdapter() };

  const requested = opts.framework ?? frameworkFromConfig(config);
  const resolved = await resolveAdapter(requested, {
    projectRoot: repo,
    config: withFlagOverrides(config, opts),
    onLog: (line) => ui.note(pc.dim(`  ${line}`)),
  });

  if (!resolved.detection.ok) {
    throw new CliError(
      `The ${resolved.adapter.displayName} adapter cannot prepare this project.`,
      { hint: resolved.detection.reason },
    );
  }
  if (!resolved.detection.platforms.includes(opts.platform)) {
    throw new CliError(
      `The ${resolved.adapter.displayName} adapter does not build for ${opts.platform}.`,
      { hint: `It supports: ${resolved.detection.platforms.join(', ') || 'nothing on this project'}.` },
    );
  }

  ui.note(
    pc.dim(`  ${resolved.adapter.displayName}${resolved.detection.summary ? `, ${resolved.detection.summary}` : ''}`),
  );
  // Only worth warning about when something is actually going to be compiled.
  // A range narrowed to its two boundaries has no interior left to test.
  if (resolved.adapter.candidateKind === 'binary' && commits.length > 2) {
    ui.note(
      pc.dim(
        `  every candidate is compiled, so expect minutes per round rather than seconds ` +
          `(${plannedRounds(commits.length)} rounds).`,
      ),
    );
  }

  const precheck = await resolved.adapter.precheck?.({
    projectPath: repo,
    goodSha: commits[0]!.sha,
    badSha: commits[commits.length - 1]!.sha,
    platform: opts.platform,
  });
  if (precheck && !precheck.ok) {
    throw new CliError(precheck.reason ?? 'This range cannot be bisected with the chosen adapter.');
  }
  for (const warning of precheck?.warnings ?? []) ui.note(pc.yellow(`  ${warning}`));

  return { name: resolved.name, adapter: resolved.adapter };
}

/** ceil(log2(n)), 64 commits resolve in 6 classification decisions. */
function plannedRounds(commitCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(commitCount)));
}

function frameworkFromConfig(config: MobileBisectConfig): FrameworkName | undefined {
  const value = config.framework;
  return value && value !== 'auto' ? value : undefined;
}

/** A flag beats the config for the same setting; nothing else is touched. */
function withFlagOverrides(config: MobileBisectConfig, opts: RunOptions): MobileBisectConfig {
  const build = {
    ...config.build,
    ...(opts.scheme ? { scheme: opts.scheme } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
  };
  return { ...config, build };
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export async function resumeCommand(opts: ResumeOptions): Promise<number> {
  const repo = path.resolve(opts.cwd);
  const store = await pickResumableRun(repo, opts.runId);

  const state = await store.loadState();
  if (!state) {
    throw new CliError(`Run \`${store.runId}\` has no saved state to resume from.`, {
      hint: 'Start a fresh search with `mobile-bisect run --good <ref> --bad <ref>`.',
    });
  }
  if (state.finishedAt) {
    throw new CliError(`Run \`${store.runId}\` already finished.`, {
      hint: `See it with \`mobile-bisect report ${store.runId}\`.`,
    });
  }

  const sidecar = await readSidecar(store.dir);
  if (!sidecar) {
    throw new CliError(`Run \`${store.runId}\` is missing run.json, so it can't be resumed.`, {
      hint: 'Start a fresh search with `mobile-bisect run`.',
    });
  }

  const flow = opts.flow ? await loadFlow(path.resolve(repo, opts.flow)) : sidecar.flow;
  const resumed: RunSidecar = { ...sidecar, flow, dryRun: opts.dryRun ?? sidecar.dryRun };
  const { config } = await loadConfig(repo);
  const runner = await buildRunner({
    opts: { ...toRunOptions(opts, resumed), cwd: opts.cwd } as RunOptions,
    commits: state.commits,
    flow,
    config,
    store,
  });

  await ensureToolDirIgnored(repo);
  const ui = await openUi(opts, store, { port: opts.port, open: opts.open });
  // Replay what already happened so the rail picks up where it left off.
  for (const event of await store.readEvents()) ui.handle(event);

  const framework = await buildAdapter({
    opts: { ...toRunOptions(opts, resumed), cwd: opts.cwd } as RunOptions,
    config,
    repo,
    commits: state.commits,
    ui,
  });

  const engine = new BisectRun({
    repo,
    store,
    ui,
    flow,
    runner: runner.runner,
    adapter: framework.adapter,
    sidecar: resumed,
  });
  return engine.resume(state);
}

async function pickResumableRun(repo: string, runId?: string): Promise<RunStore> {
  if (runId) return RunStore.open(repo, runId);

  const ids = await RunStore.list(repo);
  for (const id of ids) {
    const candidate = await RunStore.open(repo, id);
    const state = await candidate.loadState();
    if (state && !state.finishedAt) return candidate;
  }
  throw new CliError('No unfinished run to resume.', {
    hint:
      ids.length > 0
        ? `Finished runs: ${ids.slice(0, 5).join(', ')}. Open one with \`mobile-bisect report <run-id>\`.`
        : 'Start one with `mobile-bisect run --good <ref> --bad <ref>`.',
  });
}

// ---------------------------------------------------------------------------
// the search itself
// ---------------------------------------------------------------------------

class BisectRun {
  private readonly repo: string;
  private readonly store: RunStore;
  private readonly ui: Ui;
  private readonly flow: FlowDefinition;
  private readonly runner: MobileRuntimeRunner;
  private readonly adapter: FrameworkAdapter;
  private readonly sidecar: RunSidecar;
  private readonly policy = new RetryPolicy({ maxAttempts: 2 });

  private bisector!: Bisector;
  private appendQueue: Promise<void> = Promise.resolve();
  private readonly sessions = new Set<string>();
  private readonly worktrees = new Set<git.Worktree>();
  /** Candidates being evaluated ahead of time when --concurrency > 1. */
  private readonly speculative = new Map<string, Promise<CommitResult>>();
  private sessionLock: Promise<void> = Promise.resolve();
  private aborted = false;
  private closing = false;
  /** Only used when the search resolves before the loop can run (2 commits). */
  private injectedDiagnosis?: string;
  private readonly completed = new Set<string>();

  constructor(deps: {
    repo: string;
    store: RunStore;
    ui: Ui;
    flow: FlowDefinition;
    runner: MobileRuntimeRunner;
    adapter: FrameworkAdapter;
    sidecar: RunSidecar;
  }) {
    this.repo = deps.repo;
    this.store = deps.store;
    this.ui = deps.ui;
    this.flow = deps.flow;
    this.runner = deps.runner;
    this.adapter = deps.adapter;
    this.sidecar = deps.sidecar;
  }

  private emit = (event: BisectEvent): void => {
    let clean = redactDeep(event);
    if (clean.type === 'culprit.found' && !clean.diagnosis && this.injectedDiagnosis) {
      clean = { ...clean, diagnosis: this.injectedDiagnosis };
    }
    if (clean.type === 'commit.completed') {
      // A speculative run and the Bisector can both announce the same verdict.
      const key = `${clean.result.sha}:${clean.result.state}`;
      if (this.completed.has(key)) return;
      this.completed.add(key);
    }
    if (this.closing && clean.type !== 'report.ready') return;
    this.appendQueue = this.appendQueue.then(() => this.store.append(clean)).catch(() => {});
    this.ui.handle(clean);
  };

  async start(commits: CommitSummary[], meta: BisectMeta): Promise<number> {
    // With no interior to search the boundaries are already adjacent, and the
    // Bisector names the culprit inside its constructor, so the diagnosis has
    // to be ready before that happens.
    if (commits.length === 2) {
      this.injectedDiagnosis = await this.diagnosisFor(
        boundaryResult(commits[0]!, 'good', this.sidecar.expect),
        boundaryResult(commits[1]!, 'bad', this.sidecar.expect),
      );
    }
    this.bisector = new Bisector({ commits, meta, emit: this.emit });
    if (this.injectedDiagnosis) this.bisector.setDiagnosis(this.injectedDiagnosis);
    return this.drive();
  }

  async resume(state: BisectState): Promise<number> {
    this.bisector = Bisector.resume(state, this.emit);
    this.ui.note(
      pc.dim(
        `  resuming ${this.store.runId}, ${Object.keys(state.results).length} commits already classified`,
      ),
    );
    return this.drive();
  }

  private async drive(): Promise<number> {
    const detach = this.installSignalHandlers();
    try {
      while (!this.bisector.isComplete && !this.aborted) {
        const candidate = this.bisector.nextCandidate();
        if (!candidate) break;

        this.prefetch(candidate);
        const result = await this.evaluate(candidate);
        if (this.aborted) break;

        // culprit.found is emitted synchronously inside record(), so the
        // diagnosis has to be attached before the verdict that resolves it.
        if (this.resolvesWith(result)) await this.attachDiagnosis(result);

        this.bisector.record(result);
        await this.persistState();
        this.releaseStaleSpeculation();
      }

      if (this.aborted) return 130;
      // `return await` matters: a bare `return promise` would let the finally
      // block tear the run down while the report is still rendering.
      return await this.finish();
    } finally {
      this.closing = true;
      detach();
      await this.cleanup();
      await this.appendQueue;
      await this.ui.close();
    }
  }

  // --- candidate evaluation ------------------------------------------------

  private async evaluate(commit: CommitSummary): Promise<CommitResult> {
    const inFlight = this.speculative.get(commit.sha);
    if (inFlight) {
      this.speculative.delete(commit.sha);
      this.ui.note(pc.dim(`  ${commit.shortSha} was already running ahead, using that result`));
      return inFlight;
    }
    return this.runCandidate(commit, true);
  }

  /**
   * One candidate, end to end. `active` candidates report through the Bisector;
   * speculative ones emit the same events directly, since the Bisector only
   * ever tracks a single active commit.
   */
  private async runCandidate(commit: CommitSummary, active: boolean): Promise<CommitResult> {
    const started = Date.now();
    let worktree: git.Worktree | undefined;
    let session: Session | undefined;
    let candidate: PreparedCandidate | undefined;

    try {
      worktree = await git.createWorktree(this.repo, commit.sha);
      this.worktrees.add(worktree);

      // Preparation comes first and can be the expensive half: a JS swap is
      // seconds, a native build is minutes. Doing it before the device is
      // started means a failed build never burns cloud device time.
      candidate = await this.adapter.prepare(commit.sha, worktree.path, {
        platform: this.sidecar.platform,
        onLog: (line) => this.ui.note(pc.dim(`  ${line}`)),
      });

      session = await this.openSession(commit.sha);
      this.sessions.add(session.sessionId);
      const running = { sessionId: session.sessionId, streamUrl: session.streamUrl };
      if (active) this.bisector.markRunning(commit.sha, running);
      else this.emit({ type: 'commit.running', at: nowIso(), sha: commit.sha, ...running });

      await this.launch(session.sessionId, commit, candidate);

      const total = this.flow.steps.length;
      const outcome = await this.policy.run(async (attempt) => {
        const run = await this.runner.runFlow({
          sessionId: session!.sessionId,
          flow: this.flow,
          assertion: this.sidecar.expect,
          timeoutMs: this.sidecar.timeoutMs,
          onStep: (index, label) => {
            if (active) this.bisector.step(commit.sha, index, total, label);
            else this.emit({ type: 'flow.step', at: nowIso(), sha: commit.sha, index, total, label });
          },
        });

        // Persist the failed attempt so a resumed run knows it happened.
        if (run.verdict === 'inconclusive' && attempt < this.policy.maxAttempts) {
          const interim: CommitResult = {
            sha: commit.sha,
            subject: commit.subject,
            author: commit.author,
            state: 'inconclusive',
            runId: run.runId,
            assertion: this.sidecar.expect,
            assertionPassed: false,
            reason: run.reason,
            durationMs: run.durationMs,
            attempt,
          };
          if (active) this.bisector.record(interim);
          else this.emit({ type: 'commit.completed', at: nowIso(), result: interim });
          this.ui.note(pc.dim(`  ${commit.shortSha} was inconclusive, retrying once`));
        }
        return run;
      });

      const artifacts = await this.runner.collectArtifacts(outcome.result.runId).catch(() => ({}));
      return {
        ...artifacts,
        sha: commit.sha,
        subject: commit.subject,
        author: commit.author,
        state: outcome.state,
        runId: outcome.result.runId,
        assertion: this.sidecar.expect,
        assertionPassed: outcome.state === 'good',
        reason: outcome.downgraded ? outcome.reason! : outcome.result.reason,
        durationMs: outcome.result.durationMs || Date.now() - started,
        attempt: outcome.attempts,
      };
    } catch (e) {
      // A candidate that cannot even be prepared is skipped, never blamed.
      return {
        sha: commit.sha,
        subject: commit.subject,
        author: commit.author,
        state: 'skipped',
        assertion: this.sidecar.expect,
        reason: `Could not evaluate this commit: ${messageOf(e)}`,
        durationMs: Date.now() - started,
        attempt: 1,
      };
    } finally {
      await candidate?.dispose().catch(() => {});
      await this.release(worktree, session?.sessionId);
    }
  }

  /**
   * Hands the prepared candidate to the device.
   *
   * A bundle candidate is a URL the dev client opens. A binary candidate is an
   * artifact the runtime has to ingest first; the resulting build id goes back
   * to the adapter so a resumed run installs the same binary instead of
   * compiling and uploading it a second time.
   */
  private async launch(
    sessionId: string,
    commit: CommitSummary,
    candidate: PreparedCandidate,
  ): Promise<void> {
    if (candidate.kind === 'bundle') {
      await this.runner.installOrLaunch({
        sessionId,
        bundleUrl: candidate.bundleUrl,
        buildId: commit.sha,
        resetState: true,
      });
      return;
    }

    let buildId = candidate.buildId;
    if (!buildId && candidate.appPath) {
      if (!this.runner.uploadBuild) {
        throw new CliError(
          `The ${this.adapter.displayName} adapter builds a binary per commit, but this runtime cannot upload one.`,
          { hint: 'Use a bundle-swapping framework, or a runner that implements uploadBuild.' },
        );
      }
      const uploaded = await this.runner.uploadBuild({
        appPath: candidate.appPath,
        platform: candidate.platform,
        version: commit.shortSha,
      });
      buildId = uploaded.buildId;
      await this.adapter.noteUploaded?.(commit.sha, buildId, candidate.platform).catch(() => {});
    }

    await this.runner.installOrLaunch({
      sessionId,
      ...(buildId ? { buildId } : {}),
      ...(candidate.appPath ? { appPath: candidate.appPath } : {}),
      ...(candidate.bundleId ? { bundleId: candidate.bundleId } : {}),
      resetState: true,
    });
  }

  /**
   * FakeRunner binds the next session to whichever candidate was set last, so
   * parallel starts have to be serialised around that pair of calls.
   */
  private async openSession(sha: string): Promise<Session> {
    const previous = this.sessionLock;
    let unlock!: () => void;
    this.sessionLock = new Promise<void>((resolve) => (unlock = resolve));
    await previous;
    try {
      if (this.runner instanceof FakeRunner) this.runner.setCandidate(sha);
      return await this.runner.startSession({
        platform: this.sidecar.platform,
        deviceModel: this.sidecar.deviceModel,
        osVersion: this.sidecar.osVersion,
      });
    } finally {
      unlock();
    }
  }

  private async release(worktree?: git.Worktree, sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessions.delete(sessionId);
      await this.runner.stopSession(sessionId).catch(() => {});
    }
    if (worktree) {
      this.worktrees.delete(worktree);
      await worktree.cleanup().catch(() => {});
    }
  }

  // --- speculative execution (--concurrency) -------------------------------

  /** Start the candidates the search is most likely to want next. */
  private prefetch(active: CommitSummary): void {
    const extra = Math.max(1, this.sidecar.concurrency) - 1;
    if (extra <= 0 || this.aborted) return;

    for (const commit of this.frontier(active, extra)) {
      const promise = this.runCandidate(commit, false).catch(
        (e): CommitResult => ({
          sha: commit.sha,
          subject: commit.subject,
          author: commit.author,
          state: 'skipped',
          assertion: this.sidecar.expect,
          reason: `Could not evaluate this commit: ${messageOf(e)}`,
          attempt: 1,
        }),
      );
      this.speculative.set(commit.sha, promise);
    }
  }

  /** Midpoints of the sub-ranges either verdict would leave behind. */
  private frontier(active: CommitSummary, want: number): CommitSummary[] {
    const state = this.bisector.state;
    const [lo, hi] = state.activeRange;
    const mid = state.commits.findIndex((c) => c.sha === active.sha);
    const out: CommitSummary[] = [];
    const queue: [number, number][] = [
      [lo, mid - 1],
      [mid + 1, hi],
    ];

    while (queue.length > 0 && out.length < want) {
      const [l, h] = queue.shift()!;
      if (l > h) continue;
      const m = Math.floor((l + h) / 2);
      const commit = state.commits[m];
      if (commit && !state.results[commit.sha] && !this.speculative.has(commit.sha)) {
        out.push(commit);
      }
      queue.push([l, m - 1], [m + 1, h]);
    }
    return out;
  }

  /** Speculative runs the narrowed range can no longer use still get reported. */
  private releaseStaleSpeculation(): void {
    const state = this.bisector.state;
    const [lo, hi] = state.activeRange;
    for (const [sha, promise] of [...this.speculative]) {
      const index = state.commits.findIndex((c) => c.sha === sha);
      if (index >= lo && index <= hi && !this.bisector.isComplete) continue;
      this.speculative.delete(sha);
      void promise.then((result) => {
        this.emit({ type: 'commit.completed', at: nowIso(), result });
      });
    }
  }

  // --- outcome -------------------------------------------------------------

  /** Would recording this verdict collapse the range and name a culprit? */
  private resolvesWith(result: CommitResult): boolean {
    if (result.state !== 'good' && result.state !== 'bad') return false;
    const state = this.bisector.state;
    const [lo, hi] = state.activeRange;
    const index = state.commits.findIndex((c) => c.sha === result.sha);
    if (index < 0) return false;
    return result.state === 'good' ? index + 1 > hi : lo > index - 1;
  }

  private async attachDiagnosis(result: CommitResult): Promise<void> {
    const state = this.bisector.state;
    const index = state.commits.findIndex((c) => c.sha === result.sha);
    const goodIndex = result.state === 'good' ? index : index - 1;
    const badIndex = result.state === 'good' ? index + 1 : index;

    const lastGood = this.resultAt(goodIndex, 'good', result);
    const firstBad = this.resultAt(badIndex, 'bad', result);
    if (!lastGood || !firstBad) return;

    const sentence = await this.diagnosisFor(lastGood, firstBad);
    if (sentence) this.bisector.setDiagnosis(sentence);
  }

  /** The stored verdict for a commit, or a synthetic one for an untested boundary. */
  private resultAt(
    index: number,
    boundary: 'good' | 'bad',
    pending: CommitResult,
  ): CommitResult | undefined {
    const commit = this.bisector.state.commits[index];
    if (!commit) return undefined;
    if (commit.sha === pending.sha) return pending;
    return (
      this.bisector.state.results[commit.sha] ??
      boundaryResult(commit, boundary, this.sidecar.expect)
    );
  }

  private async diagnosisFor(
    lastGood: CommitResult,
    firstBad: CommitResult,
  ): Promise<string | undefined> {
    try {
      const diff = await git.showDiff(this.repo, firstBad.sha);
      return diagnose({ lastGood, firstBad, diff, expect: this.sidecar.expect }).sentence;
    } catch (e) {
      this.ui.note(pc.dim(`  could not diff the culprit: ${messageOf(e)}`));
      return undefined;
    }
  }

  private async finish(): Promise<number> {
    await this.persistState();
    if (!this.bisector.culprit) return 1; // the Bisector already emitted search.failed

    await this.appendQueue;
    const report = await loadReport();
    try {
      const outPath = await report.renderReport({
        runDir: this.store.dir,
        allowRemoteMedia: !this.sidecar.dryRun,
        inlineAssets: !this.sidecar.dryRun,
      });
      this.emit({
        type: 'report.ready',
        at: nowIso(),
        reportPath: path.relative(this.repo, outPath) || outPath,
      });
    } catch (e) {
      this.ui.note(pc.yellow(`  could not render the report: ${messageOf(e)}`));
    }
    await this.appendQueue;
    return 0;
  }

  private async persistState(): Promise<void> {
    await this.store.saveState(redactDeep(this.bisector.state));
  }

  // --- interruption --------------------------------------------------------

  private installSignalHandlers(): () => void {
    let hard = false;
    const onSignal = () => {
      if (hard) process.exit(130);
      hard = true;
      this.aborted = true;
      void this.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }

  /** Ctrl-C: stop devices, remove worktrees, flush state, say how to resume. */
  private async abort(): Promise<void> {
    this.ui.note(pc.yellow('\n  interrupted, stopping devices and cleaning up worktrees…'));
    this.closing = true;
    await this.cleanup();
    try {
      await this.persistState();
    } catch {
      /* the resume hint is still worth printing */
    }
    await this.appendQueue;
    await this.ui.close();
    process.stdout.write(
      `\n  Resume where you left off:\n    ${pc.cyan(`mobile-bisect resume ${this.store.runId}`)}\n\n`,
    );
    process.exit(130);
  }

  private async cleanup(): Promise<void> {
    for (const sessionId of [...this.sessions]) {
      this.sessions.delete(sessionId);
      await this.runner.stopSession(sessionId).catch(() => {});
    }
    for (const worktree of [...this.worktrees]) {
      this.worktrees.delete(worktree);
      await worktree.cleanup().catch(() => {});
    }
    // Metro servers, allocated ports and any shared build state the adapter is
    // holding. Cached artifacts survive on purpose, a resume wants them.
    await this.adapter.dispose?.().catch(() => {});
    await git.cleanupAllWorktrees(this.repo).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// setup helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function boundaryResult(
  commit: CommitSummary,
  state: 'good' | 'bad',
  assertion: string,
): CommitResult {
  return {
    sha: commit.sha,
    subject: commit.subject,
    author: commit.author,
    state,
    assertion,
    assertionPassed: state === 'good',
    reason:
      state === 'good'
        ? 'Known good: this is the --good boundary, taken on trust.'
        : 'Known bad: this is the --bad boundary, taken on trust.',
    attempt: 0,
  };
}

async function enumerateCommits(
  repo: string,
  opts: RunOptions,
  config: MobileBisectConfig,
): Promise<CommitSummary[]> {
  let commits: CommitSummary[];
  try {
    commits = await git.listCandidates(repo, opts.good, opts.bad);
  } catch (e) {
    throw new CliError(messageOf(e), {
      hint: 'Check that both refs exist and that --good is an ancestor of --bad.',
    });
  }

  if (commits.length < 2) {
    throw new CliError(`There is nothing to bisect between \`${opts.good}\` and \`${opts.bad}\`.`, {
      hint: 'Pick a --good ref that is further back in history.',
    });
  }

  const max = opts.maxCandidates ?? config.maxCandidates ?? 64;
  if (commits.length > max) {
    throw new CliError(
      `${commits.length} commits between \`${opts.good}\` and \`${opts.bad}\`, more than the ${max}-commit guard.`,
      {
        hint: `That is about ${Math.ceil(Math.log2(commits.length))} device runs. Pick a closer --good ref, or raise --max-candidates ${commits.length}.`,
      },
    );
  }
  return commits;
}

function buildMeta(input: {
  opts: RunOptions;
  flow: FlowDefinition;
  flowPath?: string;
  expect: string;
  commits: CommitSummary[];
  repo: string;
}): BisectMeta {
  const { opts, flow, flowPath, expect, commits, repo } = input;
  const parts = [
    'npx mobile-bisect run',
    `--good ${opts.good}`,
    `--bad ${opts.bad}`,
    flowPath ? `--flow ${path.relative(repo, flowPath) || flowPath}` : '',
    `--expect ${JSON.stringify(expect)}`,
    opts.deviceModel ? `--device-model ${JSON.stringify(opts.deviceModel)}` : '',
    opts.osVersion ? `--os-version ${opts.osVersion}` : '',
    opts.concurrency > 1 ? `--concurrency ${opts.concurrency}` : '',
    opts.dryRun ? '--dry-run' : '',
  ].filter(Boolean);

  return {
    runId: makeRunId(flow.name),
    command: parts.join(' '),
    flowName: flow.name,
    goodRef: opts.good,
    badRef: opts.bad,
    expect,
    totalCommits: commits.length,
    plannedRounds: plannedRounds(commits.length),
  };
}

function makeRunId(flowName: string): string {
  // 20260807T234910, sortable, so lexical order is time order.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const slug =
    flowName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'run';
  return `${stamp}-${slug}-${Math.random().toString(36).slice(2, 5)}`;
}

function toRunOptions(opts: ResumeOptions, sidecar: RunSidecar): Partial<RunOptions> {
  return {
    cwd: opts.cwd,
    platform: sidecar.platform,
    deviceModel: sidecar.deviceModel,
    osVersion: sidecar.osVersion,
    timeoutMs: sidecar.timeoutMs,
    concurrency: sidecar.concurrency,
    dryRun: sidecar.dryRun,
    culprit: sidecar.culpritSha,
    flaky: sidecar.flakySha,
    stepDelayMs: sidecar.stepDelayMs,
    // Resuming with a different adapter would mix candidate kinds mid-search.
    framework: sidecar.framework,
  };
}

async function buildRunner(input: {
  opts: RunOptions;
  commits: CommitSummary[];
  flow: FlowDefinition;
  config: MobileBisectConfig;
  store: RunStore;
}): Promise<{ runner: MobileRuntimeRunner; culpritSha?: string; flakySha?: string }> {
  const { opts, commits, flow, config, store } = input;

  if (opts.dryRun) {
    const resolve = async (ref?: string): Promise<string | undefined> => {
      if (!ref) return undefined;
      const direct = commits.find((c) => c.sha === ref || c.shortSha === ref);
      if (direct) return direct.sha;
      try {
        const sha = await git.resolveRef(path.resolve(opts.cwd), ref);
        return commits.some((c) => c.sha === sha) ? sha : undefined;
      } catch {
        return undefined;
      }
    };

    // Default to a culprit two-thirds in: far enough from either boundary that
    // the search has to do real work.
    const culpritSha =
      (await resolve(opts.culprit)) ?? commits[Math.floor(commits.length * 0.65)]!.sha;
    const flakySha = await resolve(opts.flaky);

    return {
      runner: new FakeRunner({ culpritSha, commits, stepDelayMs: opts.stepDelayMs, flakySha }),
      culpritSha,
      flakySha,
    };
  }

  const api = await loadRunner();
  const auth = await api.checkRevylAuth();
  if (!auth.ok) {
    throw new CliError(`Revyl authentication is not ready: ${auth.message}`, {
      hint: 'Log in with the Revyl CLI, or export REVYL_API_KEY. Or try it offline first with --dry-run.',
    });
  }
  return {
    runner: api.createRevylRunner({
      platform: opts.platform,
      deviceModel: opts.deviceModel ?? config.deviceModel,
      osVersion: opts.osVersion ?? config.osVersion,
      appId: flow.appId ?? config.appId,
      buildId: config.build?.buildId,
      projectRoot: path.resolve(opts.cwd),
      timeoutMs: opts.timeoutMs,
      flow,
      runDir: store.dir,
      artifactsDir: store.artifactsDir,
    }),
  };
}

async function openUi(
  opts: { ui: boolean; json: boolean },
  store: RunStore,
  serveOpts: { port: number; open: boolean },
): Promise<Ui> {
  const sinks: EventSink[] = [];
  const interactive = opts.ui && process.stdout.isTTY === true && !process.env.NO_COLOR;

  if (opts.json) sinks.push(new JsonSink());
  else if (interactive) sinks.push(new LiveSink());
  else sinks.push(new PlainSink());

  const merged = fanout(sinks);
  let closeServer: (() => Promise<void>) | undefined;

  // The live server tails events.jsonl, so RunStore.append is what feeds it.
  if (!opts.json && serveOpts.port > 0) {
    try {
      const report = await loadReport();
      const server = await report.serve({
        runDir: store.dir,
        port: serveOpts.port,
        open: serveOpts.open,
      });
      closeServer = () => server.close();
      merged.note(pc.dim(`  live view  ${pc.cyan(server.url)}`));
    } catch {
      merged.note(pc.dim(`  live view unavailable on port ${serveOpts.port}, terminal only`));
    }
  }

  return {
    handle: (e) => merged.handle(e),
    note: (text) => merged.note(text),
    close: async () => {
      await merged.close();
      await closeServer?.();
    },
  };
}

async function readSidecar(dir: string): Promise<RunSidecar | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) as RunSidecar;
  } catch {
    return null;
  }
}

/**
 * Make the tool directory invisible to git: a `.gitignore` of `*` inside it
 * ignores its own contents, so runs and worktrees never show up as untracked
 * work, and we never edit a file the user owns.
 */
export async function ensureToolDirIgnored(repo: string): Promise<void> {
  const dir = path.join(repo, TOOL_DIR);
  await mkdir(dir, { recursive: true });
  const marker = path.join(dir, '.gitignore');
  try {
    await readFile(marker, 'utf8');
  } catch {
    await writeFile(marker, '*\n', 'utf8');
  }
}

async function resolveFlowPath(
  repo: string,
  explicit: string | undefined,
  dryRun: boolean,
): Promise<string | undefined> {
  if (explicit) return path.resolve(repo, explicit);
  const found = await findFlowFile(repo);
  if (found) return found;
  if (dryRun) return undefined;
  throw new CliError('No flow file found.', {
    hint: 'Point at one with --flow flows/checkout.yaml, or run `mobile-bisect init` to scaffold one.',
    exitCode: 2,
  });
}

/** Used only by --dry-run when the project has no flow yet. */
function syntheticFlow(): FlowDefinition {
  return {
    name: 'dry-run-flow',
    steps: [
      { label: 'Launch the app', launch: { resetState: true } },
      { label: 'Open the first item', tap: 'first item' },
      { label: 'Add it to the cart', tap: 'Add to cart' },
      { label: 'Open the cart', tap: 'Cart' },
      { label: 'Apply a coupon', tap: 'Apply' },
      { label: 'Place the order', tap: 'Place order' },
      { label: 'Assert the confirmation', assert: 'Order confirmed' },
    ],
  };
}
