import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GradleAdapter } from './gradle.js';
import { fakeApk, stubExec, type RecordedCall } from './test-helpers.js';

const SHA = 'c'.repeat(40);
const OTHER_SHA = 'd'.repeat(40);

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-gradle-'));
  worktree = path.join(root, 'wt');
  await scaffold(worktree);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function scaffold(
  dir: string,
  opts: { modules?: string[]; applicationId?: string; wrapper?: boolean } = {},
) {
  const modules = opts.modules ?? ['app'];
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'settings.gradle'),
    modules.map((m) => `include ':${m}'`).join('\n'),
    'utf8',
  );
  if (opts.wrapper ?? true) await writeFile(path.join(dir, 'gradlew'), '#!/bin/sh', 'utf8');
  for (const m of modules) {
    await mkdir(path.join(dir, m), { recursive: true });
    await writeFile(
      path.join(dir, m, 'build.gradle'),
      `android { defaultConfig { applicationId "${opts.applicationId ?? 'com.orbit.store'}" } }`,
      'utf8',
    );
  }
}

/** Materialises the APK when gradlew is "run", the way a real assemble would. */
function assemblingExec(variant = 'debug', module = 'app') {
  return stubExec({
    onCall: async (call: RecordedCall) => {
      if (!path.basename(call.command).startsWith('gradle')) return;
      await fakeApk(path.join(call.cwd, module), variant);
    },
  });
}

describe('GradleAdapter.detect', () => {
  it('accepts a settings.gradle with an :app module', async () => {
    const d = await new GradleAdapter({ projectRoot: root }).detect(worktree);

    expect(d.ok).toBe(true);
    expect(d.platforms).toEqual(['android']);
    expect(d.summary).toContain(':app');
  });

  it('picks :app even when other modules exist, since that is the convention', async () => {
    const dir = path.join(root, 'multi');
    await scaffold(dir, { modules: ['app', 'wear', 'core'] });

    const d = await new GradleAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(true);
    expect(d.summary).toContain(':app');
  });

  it('refuses to guess when no module is called app', async () => {
    const dir = path.join(root, 'odd');
    await scaffold(dir, { modules: ['phone', 'wear'] });

    const d = await new GradleAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/build\.module/);
  });

  it('accepts an ambiguous project once the module is configured', async () => {
    const dir = path.join(root, 'odd2');
    await scaffold(dir, { modules: ['phone', 'wear'] });

    const d = await new GradleAdapter({ projectRoot: root, module: 'phone' }).detect(dir);
    expect(d.ok).toBe(true);
  });

  it('scores a nested android/ project below a standalone one', async () => {
    const nested = path.join(root, 'rn');
    await scaffold(path.join(nested, 'android'));
    await writeFile(path.join(nested, 'package.json'), '{"name":"rn"}', 'utf8');

    const standalone = await new GradleAdapter({ projectRoot: root }).detect(worktree);
    const rn = await new GradleAdapter({ projectRoot: root }).detect(nested);
    expect(rn.ok).toBe(true);
    expect(rn.confidence).toBeLessThan(standalone.confidence);
  });

  it('says what is missing when there is no Gradle build', async () => {
    const dir = path.join(root, 'empty');
    await mkdir(dir, { recursive: true });

    const d = await new GradleAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/settings\.gradle/);
  });
});

describe('GradleAdapter.prepare', () => {
  it('assembles the debug variant and hands back the apk', async () => {
    const exec = assemblingExec();
    const candidate = await new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, {
      platform: 'android',
    });

    expect(candidate.kind).toBe('binary');
    expect(candidate.appPath).toMatch(/\.apk$/);
    expect(candidate.bundleId).toBe('com.orbit.store');

    const call = exec.calls[0]!;
    expect(call.args[0]).toBe(':app:assembleDebug');
    expect(call.args).toContain('--build-cache');
    expect(call.args).toContain('--console=plain');
  });

  it('uses the wrapper when the project ships one', async () => {
    const exec = assemblingExec();
    await new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, {
      platform: 'android',
    });
    expect(exec.calls[0]!.command).toMatch(/gradlew$/);
  });

  it('falls back to a system gradle when there is no wrapper', async () => {
    const dir = path.join(root, 'nowrapper');
    await scaffold(dir, { wrapper: false });
    const exec = assemblingExec();

    await new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, dir, { platform: 'android' });
    expect(exec.calls[0]!.command).toBe('gradle');
  });

  it('honours a custom variant', async () => {
    const exec = assemblingExec('freeDebug');
    const adapter = new GradleAdapter({ projectRoot: root, exec, variant: 'freeDebug' });

    const candidate = await adapter.prepare(SHA, worktree, { platform: 'android' });
    expect(exec.calls[0]!.args[0]).toBe(':app:assembleFreeDebug');
    expect(candidate.appPath).toMatch(/\.apk$/);
  });

  it('honours an explicit task', async () => {
    const exec = assemblingExec();
    const adapter = new GradleAdapter({ projectRoot: root, exec, task: ':app:myCustomAssemble' });

    await adapter.prepare(SHA, worktree, { platform: 'android' });
    expect(exec.calls[0]!.args[0]).toBe(':app:myCustomAssemble');
  });

  it('copies the apk out of the worktree, which is about to be deleted', async () => {
    const exec = assemblingExec();
    const candidate = await new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, {
      platform: 'android',
    });

    expect(candidate.appPath!.startsWith(worktree)).toBe(false);
    expect(candidate.appPath).toContain('.mobile-bisect');
  });

  it('serves a repeat request from cache', async () => {
    const exec = assemblingExec();
    const adapter = new GradleAdapter({ projectRoot: root, exec });

    await adapter.prepare(SHA, worktree, { platform: 'android' });
    const second = await adapter.prepare(SHA, worktree, { platform: 'android' });

    expect(second.cached).toBe(true);
    expect(exec.calls.filter((c) => c.args[0]?.startsWith(':app:'))).toHaveLength(1);
  });

  it('builds each commit separately', async () => {
    const exec = assemblingExec();
    const adapter = new GradleAdapter({ projectRoot: root, exec });

    const a = await adapter.prepare(SHA, worktree, { platform: 'android' });
    const b = await adapter.prepare(OTHER_SHA, worktree, { platform: 'android' });
    expect(a.appPath).not.toBe(b.appPath);
  });

  it('reports a compile failure with the Gradle output attached', async () => {
    const exec = stubExec({
      fail: { gradlew: { code: 1, output: 'e: Unresolved reference: orderId' } },
    });

    await expect(
      new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, {
        platform: 'android',
      }),
    ).rejects.toThrow(/Unresolved reference: orderId/);
  });

  it('says so when the assemble succeeds but produces no apk', async () => {
    const exec = stubExec();
    await expect(
      new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, worktree, {
        platform: 'android',
      }),
    ).rejects.toThrow(/no \.apk appeared/);
  });

  it('refuses an iOS platform outright', async () => {
    await expect(
      new GradleAdapter({ projectRoot: root, exec: stubExec() }).prepare(SHA, worktree, {
        platform: 'ios',
      }),
    ).rejects.toThrow(/only builds Android/);
  });

  it('records the uploaded build id for a resumed run', async () => {
    const exec = assemblingExec();
    const adapter = new GradleAdapter({ projectRoot: root, exec });

    await adapter.prepare(SHA, worktree, { platform: 'android' });
    await adapter.noteUploaded(SHA, 'build_abc', 'android');

    const again = await adapter.prepare(SHA, worktree, { platform: 'android' });
    expect(again.buildId).toBe('build_abc');
  });

  it('builds inside android/ when the project is nested', async () => {
    const nested = path.join(root, 'rn');
    await scaffold(path.join(nested, 'android'));
    const exec = assemblingExec();

    await new GradleAdapter({ projectRoot: root, exec }).prepare(SHA, nested, {
      platform: 'android',
    });
    expect(exec.calls[0]!.cwd).toBe(path.join(nested, 'android'));
  });
});
