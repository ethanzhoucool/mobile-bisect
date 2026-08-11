import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@mobile-bisect/core';
import { checkRevylAuth } from './auth.js';
import { parseSessionReport } from './cli-adapter.js';
import type { FetchLike } from './download.js';
import { RevylInfraError } from './errors.js';
import { createExecutor, resolveRevylCli, type CliExecutor, type CliResult } from './exec.js';
import { fail, ok } from './fixtures.testutil.js';
import { RevylRunner } from './runner.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

/** Replays fixtures by command shape and records every argv the runner issued. */
function fakeCli(overrides: Record<string, CliResult> = {}) {
  const calls: string[][] = [];
  const key = (args: string[]) => args.slice(0, 2).join(' ');

  const executor: CliExecutor = async (args) => {
    calls.push(args);
    const k = key(args);
    if (overrides[k]) return { ...overrides[k]!, argv: args };
    switch (k) {
      case 'auth status':
        return { ...ok('auth-status'), argv: args };
      case 'device start':
        return { ...ok('device-start'), argv: args };
      case 'device list':
        return { ...ok('device-list'), argv: args };
      case 'device info':
        return { ...ok('device-info'), argv: args };
      case 'device instruction':
        return { ...ok('device-instruction'), argv: args };
      case 'device validation':
        return { ...ok('device-validation-pass'), argv: args };
      case 'device report':
        return { ...ok('device-report'), argv: args };
      case 'device navigate':
        return { ...ok('device-navigate'), argv: args };
      case 'device kill-app':
        return { ...ok('device-kill-app'), argv: args };
      case 'device stop':
        return { ...ok('device-stop'), argv: args };
      case 'device install':
        return { ...ok('device-kill-app'), argv: args };
      case 'device logs':
        return { argv: args, code: 0, stdout: '[]', stderr: '', durationMs: 1, timedOut: false };
      default:
        return { argv: args, code: 0, stdout: '{}', stderr: '', durationMs: 1, timedOut: false };
    }
  };
  return { executor, calls, argvFor: (k: string) => calls.filter((c) => c.slice(0, 2).join(' ') === k) };
}

const FLOW: FlowDefinition = {
  name: 'checkout',
  steps: [
    { label: 'Open the featured product', type: 'instructions', step_description: 'Open the first product' },
    { label: 'Tap "Place order"', type: 'manual', step_type: 'tap', target: 'Place order button' },
  ],
  expect: 'the order confirmation screen appears',
};

let artifactsDir: string;
/** Mirrors the CLI's layout: artifactsDir sits inside the run dir. */
let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'mobile-bisect-run-'));
  artifactsDir = join(runDir, 'artifacts');
});
afterEach(() => {
  delete process.env.REVYL_CLI;
});

function runner(executor: CliExecutor, over = {}) {
  return new RevylRunner({
    executor,
    artifactsDir,
    deviceModel: 'iPhone 16',
    osVersion: 'iOS 18.5',
    bundleErrorCheck: false,
    ...over,
  });
}

describe('startSession', () => {
  it('starts a headless session and reports the live viewer URL', async () => {
    const { executor, argvFor } = fakeCli();
    const session = await runner(executor).startSession({ platform: 'ios' });

    expect(session).toEqual({
      sessionId: SESSION,
      deviceModel: 'iPhone 16',
      osVersion: 'iOS 18.5',
      streamUrl: `https://app.revyl.ai/sessions/${SESSION}`,
    });
    expect(argvFor('device start')[0]).toContain('--open=false');
  });

  it('reuses one session across candidates when asked', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor, { reuseSession: true });
    const a = await r.startSession({ platform: 'ios' });
    const b = await r.startSession({ platform: 'ios' });
    expect(b.sessionId).toBe(a.sessionId);
    expect(argvFor('device start')).toHaveLength(1);
  });

  it('reports a device that will not boot as inconclusive, not as a failing commit', async () => {
    const { executor } = fakeCli({
      'device start': fail({ stderr: 'Error: failed to start session: no capacity' }),
    });
    await expect(runner(executor).startSession({ platform: 'ios' })).rejects.toMatchObject({
      name: 'RevylInfraError',
      verdict: 'inconclusive',
      stage: 'session-start',
    });
  });
});

describe('installOrLaunch', () => {
  it('points the dev client at the candidate bundle without reinstalling native', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const bundleUrl = 'exp+orbit://expo-development-client/?url=http%3A%2F%2F10.0.0.2%3A8093';
    await r.installOrLaunch({ sessionId: SESSION, bundleUrl });

    expect(argvFor('device navigate')[0]).toEqual(
      expect.arrayContaining(['device', 'navigate', '--url', bundleUrl]),
    );
    expect(argvFor('device install')).toHaveLength(0);
  });

  it('kills the app first when the candidate must start cold', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    await r.installOrLaunch({ sessionId: SESSION, bundleUrl: 'exp+orbit://x', resetState: true });
    expect(argvFor('device kill-app')).toHaveLength(1);
  });

  it('classifies an install failure as inconclusive', async () => {
    const { executor } = fakeCli({ 'device install': fail({ stderr: 'Error: Installation failed' }) });
    const r = runner(executor, { buildId: 'build-1' });
    await r.startSession({ platform: 'ios' });
    await expect(r.installOrLaunch({ sessionId: SESSION })).rejects.toMatchObject({
      name: 'RevylInfraError',
      stage: 'install',
    });
  });

  it('classifies a bundle that will not load as inconclusive', async () => {
    const { executor } = fakeCli({ 'device validation': ok('device-validation-pass') });
    const r = runner(executor, { bundleErrorCheck: true, bundleSettleMs: 0 });
    await r.startSession({ platform: 'ios' });
    // The check asserts the *error screen* is present, so a `true` result here
    // means the candidate's JS never rendered.
    await expect(r.installOrLaunch({ sessionId: SESSION, bundleUrl: 'exp+orbit://x' })).rejects.toBeInstanceOf(
      RevylInfraError,
    );
  });

  it('proceeds when the error-screen check comes back false', async () => {
    const { executor } = fakeCli({
      'device validation': { ...ok('device-validation-fail'), code: 1, stderr: 'Error: validation failed' },
    });
    const r = runner(executor, { bundleErrorCheck: true, bundleSettleMs: 0 });
    await r.startSession({ platform: 'ios' });
    await expect(r.installOrLaunch({ sessionId: SESSION, bundleUrl: 'exp+orbit://x' })).resolves.toBeUndefined();
  });

  it('skips the bundler error-screen check for a native candidate, which has no bundler', async () => {
    const { executor, argvFor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor, { bundleErrorCheck: true, bundleSettleMs: 0 });
    await r.startSession({ platform: 'ios' });
    await r.installOrLaunch({ sessionId: SESSION, appPath: '/tmp/Orbit.app.zip' });

    expect(argvFor('device validation')).toHaveLength(0);
  });
});

describe('native builds', () => {
  it('uploads an artifact and installs the id that came back', async () => {
    const { executor, argvFor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });

    await r.installOrLaunch({ sessionId: SESSION, appPath: '/tmp/Orbit.app.zip', resetState: true });

    const upload = argvFor('build upload')[0]!;
    expect(upload).toEqual(expect.arrayContaining(['--file', '/tmp/Orbit.app.zip']));
    expect(upload).toEqual(expect.arrayContaining(['--platform', 'ios']));

    const install = argvFor('device install')[0]!;
    expect(install).toEqual(
      expect.arrayContaining(['--build-version-id', '509b8cac-7be8-448b-a31d-74591245cdcf']),
    );
  });

  it('tags the upload with the platform the session was started for', async () => {
    const { executor, argvFor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor);
    await r.startSession({ platform: 'android' });
    await r.installOrLaunch({ sessionId: SESSION, appPath: '/tmp/app.apk' });

    expect(argvFor('build upload')[0]).toEqual(expect.arrayContaining(['--platform', 'android']));
  });

  it('does not re-upload when the candidate already has a build id', async () => {
    const { executor, argvFor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });

    await r.installOrLaunch({ sessionId: SESSION, buildId: 'cached_1', appPath: '/tmp/Orbit.app.zip' });

    expect(argvFor('build upload')).toHaveLength(0);
    expect(argvFor('device install')[0]).toEqual(
      expect.arrayContaining(['--build-version-id', 'cached_1']),
    );
  });

  it('launches by bundle id when the candidate carries one', async () => {
    const { executor, argvFor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });

    await r.installOrLaunch({
      sessionId: SESSION,
      appPath: '/tmp/Orbit.app.zip',
      bundleId: 'com.orbit.store',
    });

    expect(argvFor('device launch')[0]).toEqual(
      expect.arrayContaining(['--bundle-id', 'com.orbit.store']),
    );
  });

  it('classifies a failed upload as infrastructure, never as a bad commit', async () => {
    const { executor } = fakeCli({ 'build upload': fail({ stderr: 'Error: 413 payload too large' }) });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });

    await expect(
      r.installOrLaunch({ sessionId: SESSION, appPath: '/tmp/Orbit.app.zip' }),
    ).rejects.toMatchObject({ name: 'RevylInfraError', stage: 'build-upload' });
  });

  it('refuses to guess when the upload returns no id', async () => {
    const { executor } = fakeCli({
      'build upload': { argv: [], code: 0, stdout: '{"ok":true}', stderr: '', durationMs: 1, timedOut: false },
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });

    await expect(
      r.installOrLaunch({ sessionId: SESSION, appPath: '/tmp/Orbit.app.zip' }),
    ).rejects.toThrow(/no build id/);
  });

  it('exposes uploadBuild directly, for an adapter that wants the id up front', async () => {
    const { executor } = fakeCli({ 'build upload': ok('build-upload') });
    const r = runner(executor);

    const built = await r.uploadBuild({
      appPath: '/tmp/Orbit.app.zip',
      platform: 'ios',
      version: '8d4c2f1',
    });
    expect(built).toEqual({ buildId: '509b8cac-7be8-448b-a31d-74591245cdcf', version: '8d4c2f1' });
  });
});

describe('runFlow', () => {
  it('emits onStep per step, 1-based, before the step runs', async () => {
    const { executor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const seen: Array<[number, string]> = [];
    await r.runFlow({
      sessionId: SESSION,
      flow: FLOW,
      assertion: 'the order confirmation screen appears',
      onStep: (index, label) => seen.push([index, label]),
    });
    expect(seen).toEqual([
      [1, 'Open the featured product'],
      [2, 'Tap "Place order"'],
    ]);
  });

  it('passes when the assertion holds and writes a frame per step', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'the order confirmation appears' });

    expect(result.verdict).toBe('pass');
    expect(result.stepsCompleted).toBe(2);
    expect(result.runId).toBe('22222222-2222-4222-8222-222222222222');
    // The assertion is always the last validation issued.
    expect(argvFor('device validation').at(-1)).toContain('the order confirmation appears');
    expect((await readdir(artifactsDir, { recursive: true })).filter((f) => String(f).endsWith('.png')).length).toBeGreaterThan(0);
  });

  it('fails when the assertion legitimately does not hold', async () => {
    const { executor } = fakeCli({
      'device validation': { ...ok('device-validation-fail'), code: 1, stderr: 'Error: validation failed' },
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'the order confirmation appears' });
    expect(result.verdict).toBe('fail');
    expect(result.reason).toMatch(/banner|ZZZQQQ/);
  });

  it('stops issuing actions once one cannot complete, then asks the assertion anyway', async () => {
    const { executor, argvFor } = fakeCli({
      'device instruction': { ...ok('device-instruction'), code: 1, stderr: 'Error: step failed' },
      'device validation': { ...ok('device-validation-fail'), code: 1, stderr: 'Error: validation failed' },
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'the order confirmation appears' });

    expect(argvFor('device tap')).toHaveLength(0); // the second step never ran
    expect(argvFor('device validation')).toHaveLength(1); // but the assertion did
    expect(result.verdict).toBe('fail');
    expect(result.stepsCompleted).toBe(0);
  });

  it('is inconclusive when the session dies mid-flow', async () => {
    const { executor, argvFor } = fakeCli({
      'device instruction': fail({ stderr: 'Error: no active session' }),
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'the order confirmation appears' });
    expect(result.verdict).toBe('inconclusive');
    expect(argvFor('device validation')).toHaveLength(0); // no point asking a dead device
  });

  it('is inconclusive, never fail, when a flow step cannot be expressed', async () => {
    const { executor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({
      sessionId: SESSION,
      flow: { name: 'bad', steps: [{ label: 'Loop', type: 'while', condition: 'x' }] },
      assertion: 'something',
    });
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toMatch(/not supported/);
  });

  it('re-resolves the session index before each phase so concurrent runs cannot cross wires', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    expect(argvFor('device list').length).toBeGreaterThanOrEqual(1);
    for (const argv of argvFor('device instruction')) expect(argv).toEqual(expect.arrayContaining(['-s', '0']));
  });
});

describe('collectArtifacts', () => {
  it('returns presigned screenshots and tolerates artifacts the session never produced', async () => {
    const { executor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const { runId } = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    const artifacts = await r.collectArtifacts(runId);

    expect(artifacts.screenshots?.length).toBeGreaterThan(0);
    expect(artifacts.screenshots?.[0]).toMatch(/^https:\/\//);
    expect(artifacts.localPaths?.some((p) => p.endsWith('.png'))).toBe(true);
    // No recording URL exists on this CLI surface; claiming one would break the report.
    expect(artifacts.videoUrl).toBeUndefined();
  });

  it('does not throw when every artifact is missing', async () => {
    const { executor } = fakeCli({
      'device report': fail({ stderr: 'Error: network artifact not available for this session' }),
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const { runId } = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    await expect(r.collectArtifacts(runId)).resolves.toBeTruthy();
  });
});

describe('collectArtifacts downloads frames before their links expire', () => {
  /** Counts requests and lets a chosen URL 403, the way an expired link does. */
  function stubFetch(opts: { expire?: (url: string) => boolean } = {}) {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (opts.expire?.(url)) return { ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) };
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`png:${url}`) };
    };
    return { fetchImpl, seen };
  }

  async function collect(over: Record<string, unknown> = {}, fetchImpl?: FetchLike) {
    const { executor } = fakeCli();
    const r = runner(executor, { runDir, artifactsDir: join(runDir, 'artifacts'), fetchImpl, ...over });
    await r.startSession({ platform: 'ios' });
    const { runId, verdict } = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    return { artifacts: await r.collectArtifacts(runId), runId, verdict };
  }

  it('writes every frame under names that recover step order', async () => {
    const { fetchImpl, seen } = stubFetch();
    const { artifacts, runId } = await collect({}, fetchImpl);

    const frames = parseSessionReport(ok('device-report'))!.frames;
    expect(seen).toEqual(frames.map((f) => f.url)); // every frame fetched, in step order

    const written = (await readdir(join(runDir, 'artifacts', runId))).filter((f) => f.includes('action')).sort();
    expect(written).toEqual([
      'step-01-action-00-after.png',
      'step-01-action-00-before.png',
      'step-01-action-01-after.png',
      'step-01-action-01-before.png',
      'step-02-action-00-before.png',
    ]);
    // Sorting the names reproduces execution order.
    expect([...written].sort()).toEqual(written);
    expect(artifacts.localPaths?.[0]).toBe(`artifacts/${runId}/step-01-action-00-before.png`);
  });

  it('keeps the remote URLs in screenshots and the local copies in localPaths, both, not either', async () => {
    const { fetchImpl } = stubFetch();
    const { artifacts } = await collect({}, fetchImpl);

    expect(artifacts.screenshots?.every((s) => s.startsWith('https://'))).toBe(true);
    expect(artifacts.localPaths?.every((p) => !p.startsWith('/') && !p.startsWith('https://'))).toBe(true);
    expect(artifacts.localPaths?.some((p) => p.endsWith('-live.png'))).toBe(true);
  });

  it('a frame that already expired is skipped and leaves the verdict untouched', async () => {
    // Expire exactly one frame, the fixture has two URLs ending `action-0-before`.
    const expired = parseSessionReport(ok('device-report'))!.frames[0]!.url;
    const { fetchImpl } = stubFetch({ expire: (u) => u === expired });
    const logs: string[] = [];
    const { artifacts, runId, verdict } = await collect({ onLog: (l: string) => logs.push(l) }, fetchImpl);

    expect(verdict).toBe('pass'); // artifact collection cannot influence classification
    const written = (await readdir(join(runDir, 'artifacts', runId))).filter((f) => f.includes('action')).sort();
    expect(written).toEqual([
      'step-01-action-00-after.png',
      'step-01-action-01-after.png',
      'step-01-action-01-before.png',
      'step-02-action-00-before.png',
    ]);
    expect(artifacts.localPaths).not.toContain(`artifacts/${runId}/step-01-action-00-before.png`);
    expect(artifacts.screenshots).toHaveLength(5); // the live URL list is unchanged
    expect(logs.join('\n')).toMatch(/skipped artifact .*step-01-action-00-before\.png: HTTP 403/);
  });

  it('survives a fetch that hangs, throws, or is absent entirely', async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(collect({ artifactTimeoutMs: 30 }, hang)).resolves.toBeTruthy();

    const boom: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const { verdict } = await collect({}, boom);
    expect(verdict).toBe('pass');
  });

  it('stays URL-only and touches no disk when no artifactsDir is configured', async () => {
    const { fetchImpl, seen } = stubFetch();
    const { executor } = fakeCli();
    const r = new RevylRunner({ executor, fetchImpl, bundleErrorCheck: false });
    await r.startSession({ platform: 'ios' });
    const { runId } = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    const artifacts = await r.collectArtifacts(runId);

    expect(seen).toEqual([]);
    expect(artifacts.localPaths).toBeUndefined();
    expect(artifacts.screenshots?.every((s) => s.startsWith('https://'))).toBe(true);
  });
});

describe('stopSession', () => {
  it('stops by resolved index and is a no-op once the session is gone', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    await r.stopSession(SESSION);
    expect(argvFor('device stop')[0]).toEqual(expect.arrayContaining(['-s', '0']));
    await expect(r.stopSession('does-not-exist')).resolves.toBeUndefined();
  });

  it('keeps a reused session alive until dispose', async () => {
    const { executor, argvFor } = fakeCli();
    const r = runner(executor, { reuseSession: true });
    await r.startSession({ platform: 'ios' });
    await r.stopSession(SESSION);
    expect(argvFor('device stop')).toHaveLength(0);
    await r.dispose();
    expect(argvFor('device stop')).toHaveLength(1);
  });
});

describe('checkRevylAuth', () => {
  it('reports the org without echoing a credential', async () => {
    const { executor } = fakeCli();
    const check = await checkRevylAuth({ executor });
    expect(check).toMatchObject({ ok: true, org: 'Example Org' });
    expect(check.message).not.toMatch(/rk_|rvl_|Bearer/);
  });

  it('fails cleanly when the CLI is not installed', async () => {
    process.env.REVYL_CLI = '/definitely/not/a/real/revyl';
    const check = await checkRevylAuth();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/not executable/);
  });

  it('tells the user how to authenticate rather than guessing', async () => {
    const { executor } = fakeCli({
      'auth status': fail({ code: 0, stdout: '{"authenticated": false}', stderr: '' }),
    });
    const check = await checkRevylAuth({ executor });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/revyl auth login|REVYL_API_KEY/);
  });
});

describe('credentials never leak', () => {
  it('scrubs a key echoed back by the CLI out of the thrown error', async () => {
    const { executor } = fakeCli({
      'device start': fail({ stderr: 'Error: unauthorized (api_key=notarealkey_0123456789abcdef)' }),
    });
    const r = runner(executor);
    await expect(r.startSession({ platform: 'ios' })).rejects.toThrow(/\[redacted\]/);
    await expect(r.startSession({ platform: 'ios' })).rejects.not.toThrow(/notarealkey_0123456789abcdef/);
  });

  it('scrubs a key echoed back by the CLI out of the verdict reason', async () => {
    const { executor } = fakeCli({
      'device instruction': fail({ stderr: 'Error: no active session (token=notarealkey_0123456789abcdef)' }),
    });
    const r = runner(executor);
    await r.startSession({ platform: 'ios' });
    const result = await r.runFlow({ sessionId: SESSION, flow: FLOW, assertion: 'x' });
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).not.toContain('notarealkey_0123456789abcdef');
  });

  it('scrubs onLog output from the real executor', async () => {
    const lines: string[] = [];
    const exec = createExecutor({ cliPath: '/bin/sh', onLog: (l) => lines.push(l) });
    await exec(['-c', 'echo "Error: unauthorized api_key=notarealkey_0123456789abcdef" 1>&2']);
    expect(lines.join('\n')).not.toContain('notarealkey_0123456789abcdef');
    expect(lines.join('\n')).toContain('[redacted]');
  });
});

describe('resolveRevylCli', () => {
  it('prefers an explicit path', async () => {
    await expect(resolveRevylCli('/bin/sh')).resolves.toBe('/bin/sh');
  });

  it('honours REVYL_CLI', async () => {
    process.env.REVYL_CLI = '/bin/sh';
    await expect(resolveRevylCli()).resolves.toBe('/bin/sh');
  });

  it('explains itself when the binary is missing', async () => {
    await expect(resolveRevylCli('/definitely/not/here/revyl')).rejects.toThrow(/not executable/);
  });
});

describe('the real executor', () => {
  it('reports a non-zero exit as a value rather than throwing', async () => {
    const exec = createExecutor({ cliPath: '/bin/sh' });
    const res = await exec(['-c', 'echo out; echo err 1>&2; exit 3']);
    expect(res).toMatchObject({ code: 3, timedOut: false });
    expect(res.stdout.trim()).toBe('out');
    expect(res.stderr.trim()).toBe('err');
  });

  it('reports a missing binary as a spawn error, not a crash', async () => {
    const exec = createExecutor({ cliPath: '/definitely/not/here/revyl' });
    const res = await exec(['--version']);
    expect(res.spawnError).toBeTruthy();
    expect(res.code).toBe(-1);
  });

  it('marks a timeout', async () => {
    const exec = createExecutor({ cliPath: '/bin/sh' });
    const res = await exec(['-c', 'sleep 5'], { timeoutMs: 150 });
    expect(res.timedOut).toBe(true);
  });
});
