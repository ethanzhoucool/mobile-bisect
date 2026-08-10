import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XcodeAdapter } from './xcode.js';
import { fakeSimulatorApp, stubExec, type RecordedCall } from './test-helpers.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-xcode-'));
  worktree = path.join(root, 'wt');
  await scaffoldProject(worktree, ['Orbit']);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function scaffoldProject(dir: string, schemes: string[], opts: { pods?: boolean } = {}) {
  const proj = path.join(dir, 'Orbit.xcodeproj');
  await mkdir(path.join(proj, 'xcshareddata', 'xcschemes'), { recursive: true });
  await writeFile(path.join(proj, 'project.pbxproj'), '// objects', 'utf8');
  for (const s of schemes) {
    await writeFile(path.join(proj, 'xcshareddata', 'xcschemes', `${s}.xcscheme`), '<Scheme/>');
  }
  if (opts.pods) await writeFile(path.join(dir, 'Podfile'), "platform :ios, '16.0'", 'utf8');
}

/** Materialises the .app when xcodebuild is "run", the way a real build would. */
function buildingExec(cacheDir: string, appName = 'Orbit', configuration = 'Debug') {
  return stubExec({
    onCall: async (call: RecordedCall) => {
      if (path.basename(call.command) !== 'xcodebuild') return;
      const dd = call.args[call.args.indexOf('-derivedDataPath') + 1]!;
      void cacheDir;
      await fakeSimulatorApp(dd, configuration, appName);
    },
  });
}

describe('XcodeAdapter.detect', () => {
  it('accepts a project with exactly one shared scheme', async () => {
    const adapter = new XcodeAdapter({ projectRoot: root });
    const d = await adapter.detect(worktree);

    expect(d.ok).toBe(true);
    expect(d.platforms).toEqual(['ios']);
    expect(d.summary).toContain('scheme Orbit');
  });

  it('refuses to guess between several shared schemes', async () => {
    const dir = path.join(root, 'multi');
    await scaffoldProject(dir, ['Orbit', 'OrbitStaging']);

    const d = await new XcodeAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/2 shared schemes/);
    expect(d.reason).toMatch(/build\.scheme/);
  });

  it('accepts an ambiguous project once the scheme is configured', async () => {
    const dir = path.join(root, 'multi2');
    await scaffoldProject(dir, ['Orbit', 'OrbitStaging']);

    const d = await new XcodeAdapter({ projectRoot: root, scheme: 'Orbit' }).detect(dir);
    expect(d.ok).toBe(true);
  });

  it('scores a nested ios/ project below a standalone one, so Expo keeps priority', async () => {
    const nested = path.join(root, 'rn');
    await scaffoldProject(path.join(nested, 'ios'), ['Orbit']);
    await writeFile(path.join(nested, 'package.json'), '{"name":"rn"}', 'utf8');
    await mkdir(path.join(nested), { recursive: true });

    const standalone = await new XcodeAdapter({ projectRoot: root }).detect(worktree);
    const rn = await new XcodeAdapter({ projectRoot: root }).detect(nested);
    expect(rn.ok).toBe(true);
    expect(rn.confidence).toBeLessThan(standalone.confidence);
  });

  it('explains that a bare Swift package has nothing to install', async () => {
    const dir = path.join(root, 'pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Package.swift'), '// swift-tools-version:5.9', 'utf8');

    const d = await new XcodeAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no app target/);
  });
});

describe('XcodeAdapter.prepare', () => {
  it('builds, archives, and hands back an installable artifact', async () => {
    const exec = buildingExec(root);
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    const candidate = await adapter.prepare(SHA, worktree, { platform: 'ios' });

    expect(candidate.kind).toBe('binary');
    expect(candidate.appPath).toMatch(/Orbit\.app\.zip$/);
    expect(candidate.bundleUrl).toBeUndefined();
    expect(candidate.cached).toBeUndefined();

    const xcodebuild = exec.calls.find((c) => c.command === 'xcodebuild')!;
    expect(xcodebuild.args).toContain('-scheme');
    expect(xcodebuild.args).toContain('Orbit');
    expect(xcodebuild.args).toContain('-sdk');
    expect(xcodebuild.args).toContain('iphonesimulator');
    // A simulator build must not ask for a signing identity.
    expect(xcodebuild.args).toContain('CODE_SIGNING_ALLOWED=NO');
  });

  it('archives with zip -r, because a ditto archive uploads and then fails to install', async () => {
    const exec = buildingExec(root);
    await new XcodeAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, { platform: 'ios' });

    const zip = exec.calls.find((c) => c.command === 'zip');
    expect(zip).toBeDefined();
    expect(zip!.args).toContain('-r');
    expect(exec.calls.some((c) => c.command === 'ditto')).toBe(false);
  });

  it('reads the bundle id out of the built app', async () => {
    const exec = stubExec({
      onCall: async (call) => {
        if (path.basename(call.command) !== 'xcodebuild') return;
        const dd = call.args[call.args.indexOf('-derivedDataPath') + 1]!;
        await fakeSimulatorApp(dd, 'Debug', 'Orbit', 'com.orbit.store');
      },
    });
    // plutil is stubbed, so assert the adapter asked for the right key.
    await new XcodeAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, { platform: 'ios' });
    const plutil = exec.calls.find((c) => c.command === 'plutil');
    expect(plutil?.args).toContain('CFBundleIdentifier');
  });

  it('serves the second request for a commit from cache, without rebuilding', async () => {
    const exec = buildingExec(root);
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    const first = await adapter.prepare(SHA, worktree, { platform: 'ios' });
    const builds = exec.calls.filter((c) => c.command === 'xcodebuild').length;
    const second = await adapter.prepare(SHA, worktree, { platform: 'ios' });

    expect(second.cached).toBe(true);
    expect(second.appPath).toBe(first.appPath);
    expect(exec.calls.filter((c) => c.command === 'xcodebuild')).toHaveLength(builds);
  });

  it('keeps a fresh cache per commit', async () => {
    const exec = buildingExec(root);
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    const a = await adapter.prepare(SHA, worktree, { platform: 'ios' });
    const b = await adapter.prepare(OTHER_SHA, worktree, { platform: 'ios' });

    expect(a.appPath).not.toBe(b.appPath);
    expect(exec.calls.filter((c) => c.command === 'xcodebuild')).toHaveLength(2);
  });

  it('runs pod install before building when there is a Podfile', async () => {
    const dir = path.join(root, 'pods');
    await scaffoldProject(dir, ['Orbit'], { pods: true });
    const exec = buildingExec(root);

    await new XcodeAdapter({ projectRoot: root, exec }).prepare(SHA, dir, { platform: 'ios' });

    const order = exec.calls.map((c) => path.basename(c.command));
    expect(order.indexOf('pod')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('pod')).toBeLessThan(order.indexOf('xcodebuild'));
  });

  it('reports a build failure with the compiler output attached', async () => {
    const exec = stubExec({
      fail: { xcodebuild: { code: 65, output: "error: cannot find 'orderId' in scope" } },
    });
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    await expect(adapter.prepare(SHA, worktree, { platform: 'ios' })).rejects.toThrow(
      /cannot find 'orderId' in scope/,
    );
  });

  it('says so when the build succeeds but produces no app', async () => {
    const exec = stubExec(); // xcodebuild "succeeds" and writes nothing
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    await expect(adapter.prepare(SHA, worktree, { platform: 'ios' })).rejects.toThrow(
      /no \.app appeared/,
    );
  });

  it('refuses an Android platform outright', async () => {
    const adapter = new XcodeAdapter({ projectRoot: root, exec: stubExec() });
    await expect(adapter.prepare(SHA, worktree, { platform: 'android' })).rejects.toThrow(
      /only builds iOS/,
    );
  });

  it('serialises concurrent candidates so two builds never share derived data', async () => {
    let active = 0;
    let peak = 0;
    const exec = stubExec({
      onCall: async (call) => {
        if (path.basename(call.command) !== 'xcodebuild') return;
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        const dd = call.args[call.args.indexOf('-derivedDataPath') + 1]!;
        await fakeSimulatorApp(dd, 'Debug', 'Orbit');
        active--;
      },
    });
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    await Promise.all([
      adapter.prepare(SHA, worktree, { platform: 'ios' }),
      adapter.prepare(OTHER_SHA, worktree, { platform: 'ios' }),
    ]);

    expect(peak).toBe(1);
  });

  it('records the uploaded build id so a resumed run skips the upload', async () => {
    const exec = buildingExec(root);
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    await adapter.prepare(SHA, worktree, { platform: 'ios' });
    await adapter.noteUploaded(SHA, 'build_123', 'ios');

    const again = await adapter.prepare(SHA, worktree, { platform: 'ios' });
    expect(again.buildId).toBe('build_123');
    expect(again.cached).toBe(true);
  });

  it('leaves the artifact on disk after dispose, so the comparison view can use it', async () => {
    const exec = buildingExec(root);
    const adapter = new XcodeAdapter({ projectRoot: root, exec });

    const candidate = await adapter.prepare(SHA, worktree, { platform: 'ios' });
    await candidate.dispose();

    expect((await stat(candidate.appPath!)).isFile()).toBe(true);
  });
});
