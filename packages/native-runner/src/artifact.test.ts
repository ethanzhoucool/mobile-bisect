import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findApk, findSimulatorApp, readBundleId, variantPath, zipApp } from './artifact.js';
import { fakeApk, fakeSimulatorApp, stubExec, ZIP_MAGIC } from './test-helpers.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-artifact-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findSimulatorApp', () => {
  it('finds the app in the products directory for the configuration', async () => {
    await fakeSimulatorApp(root, 'Debug', 'Orbit');

    const found = await findSimulatorApp(root, 'Debug');
    expect(found?.name).toBe('Orbit.app');
  });

  it('prefers the requested configuration when several were built', async () => {
    await fakeSimulatorApp(root, 'Release', 'Orbit');
    await fakeSimulatorApp(root, 'Debug', 'Orbit');

    const found = await findSimulatorApp(root, 'Debug');
    expect(found?.path).toContain('Debug-iphonesimulator');
  });

  it('ignores device builds, which will not install on a simulator', async () => {
    const dir = path.join(root, 'Build', 'Products', 'Debug-iphoneos');
    await mkdir(path.join(dir, 'Orbit.app'), { recursive: true });

    expect(await findSimulatorApp(root, 'Debug')).toBeUndefined();
  });

  it('is undefined when nothing was built', async () => {
    expect(await findSimulatorApp(root, 'Debug')).toBeUndefined();
  });
});

describe('zipApp', () => {
  it('archives from inside the products directory so paths stay relative', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const exec = stubExec();
    const out = path.join(root, 'out', 'Orbit.app.zip');

    await zipApp(app, out, { exec });

    const call = exec.calls[0]!;
    expect(call.command).toBe('zip');
    expect(call.args).toContain('-r');
    expect(call.cwd).toBe(path.dirname(app));
    // The bundle is named relatively, never by absolute path.
    expect(call.args[call.args.length - 1]).toBe('Orbit.app');
  });

  it('renames into place, so an interrupted zip is never mistaken for a cache hit', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const out = path.join(root, 'out', 'Orbit.app.zip');

    await zipApp(app, out, { exec: stubExec() });

    expect(await readFile(out, 'utf8')).toBe(ZIP_MAGIC);
    await expect(readFile(`${out}.partial`, 'utf8')).rejects.toThrow();
  });

  it('leaves nothing behind when zip fails', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const out = path.join(root, 'out', 'Orbit.app.zip');

    await expect(
      zipApp(app, out, { exec: stubExec({ fail: { zip: { code: 12, output: 'nothing to do' } } }) }),
    ).rejects.toThrow(/zip failed/);

    await expect(readFile(`${out}.partial`, 'utf8')).rejects.toThrow();
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });
});

describe('readBundleId', () => {
  it('extracts CFBundleIdentifier from the built bundle', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit', 'com.orbit.store');
    expect(await readBundleId(app, { exec: stubExec() })).toBe('com.orbit.store');
  });

  it('is undefined rather than fatal when plutil fails', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const exec = stubExec({ fail: { plutil: { code: 1 } } });
    expect(await readBundleId(app, { exec })).toBeUndefined();
  });
});

describe('findApk', () => {
  it('finds the apk for a simple variant', async () => {
    const moduleDir = path.join(root, 'app');
    await fakeApk(moduleDir, 'debug');

    const found = await findApk(moduleDir, 'debug');
    expect(found?.name).toBe('app-debug.apk');
  });

  it('follows Gradle nesting for a flavoured variant', async () => {
    const moduleDir = path.join(root, 'app');
    await fakeApk(moduleDir, 'freeDebug', 'app-free-debug.apk');

    const found = await findApk(moduleDir, 'freeDebug');
    expect(found?.path).toContain(path.join('apk', 'free', 'debug'));
  });

  it('prefers the universal apk when a split build emitted several', async () => {
    const moduleDir = path.join(root, 'app');
    await fakeApk(moduleDir, 'debug', 'app-arm64-v8a-debug.apk');
    await fakeApk(moduleDir, 'debug', 'app-universal-debug.apk');

    const found = await findApk(moduleDir, 'debug');
    expect(found?.name).toBe('app-universal-debug.apk');
  });

  it('is undefined when nothing was assembled', async () => {
    expect(await findApk(path.join(root, 'app'), 'debug')).toBeUndefined();
  });
});

describe('variantPath', () => {
  it('leaves a plain variant alone', () => {
    expect(variantPath('debug')).toBe('debug');
    expect(variantPath('Debug')).toBe('debug');
  });

  it('splits a flavoured variant into directories', () => {
    expect(variantPath('freeDebug')).toBe(path.join('free', 'debug'));
    expect(variantPath('paidProdRelease')).toBe(path.join('paid', 'prod', 'release'));
  });
});

describe('writeFile guard', () => {
  it('does not treat a directory as an artifact', async () => {
    const moduleDir = path.join(root, 'app');
    const dir = path.join(moduleDir, 'build', 'outputs', 'apk', 'debug');
    await mkdir(path.join(dir, 'notanapk'), { recursive: true });
    await writeFile(path.join(dir, 'output-metadata.json'), '{}', 'utf8');

    expect(await findApk(moduleDir, 'debug')).toBeUndefined();
  });
});
