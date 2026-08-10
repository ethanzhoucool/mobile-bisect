import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectExpoProject, findAppConfigFile, parseSdkVersion, readAppJson } from './detect.js';

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-detect-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('detectExpoProject', () => {
  it('accepts an Expo Router app and reads the SDK version', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { expo: '~52.0.11', 'expo-router': '~4.0.9', react: '18.3.1' },
      }),
      'app.json': JSON.stringify({ expo: { name: 'Demo', slug: 'demo', scheme: 'demo' } }),
    });
    expect(await detectExpoProject(dir)).toEqual({ ok: true, sdkVersion: '52.0.11', usesRouter: true });
  });

  it('accepts a non-router Expo app', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ dependencies: { expo: '51.0.0' } }),
    });
    expect(await detectExpoProject(dir)).toEqual({ ok: true, sdkVersion: '51.0.0', usesRouter: false });
  });

  it('rejects a directory with no package.json', async () => {
    const dir = await project({ 'README.md': 'nothing here' });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no package\.json/);
  });

  it('rejects a bare React Native app by name', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ dependencies: { 'react-native': '0.76.5', react: '18.3.1' } }),
    });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/bare React Native/);
  });

  it('rejects a project with no expo dependency at all', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ dependencies: { zod: '^3.0.0' } }) });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no "expo" dependency/);
  });

  it('never throws on a malformed package.json', async () => {
    const dir = await project({ 'package.json': '{ "name": "broken", ' });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not valid JSON/);
  });

  it('rejects a package.json that is not an object', async () => {
    const dir = await project({ 'package.json': '"just a string"' });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a JSON object/);
  });

  it('tolerates a missing sdk version in an odd range', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ dependencies: { expo: '*' } }) });
    const res = await detectExpoProject(dir);
    expect(res.ok).toBe(true);
    expect(res.sdkVersion).toBeUndefined();
  });
});

describe('parseSdkVersion', () => {
  it.each([
    ['~52.0.11', '52.0.11'],
    ['^51.0.0', '51.0.0'],
    ['>=50.0.0', '50.0.0'],
    ['52.0.0-preview.1', '52.0.0-preview.1'],
    ['52', '52'],
  ])('%s -> %s', (range, expected) => expect(parseSdkVersion(range)).toBe(expected));

  it.each(['*', 'latest', 'workspace:*', 'github:expo/expo'])('%s is unparseable', (range) =>
    expect(parseSdkVersion(range)).toBeUndefined(),
  );
});

describe('app config helpers', () => {
  it('finds app.config.ts when there is no app.json', async () => {
    const dir = await project({ 'app.config.ts': 'export default {};' });
    expect(await findAppConfigFile(dir)).toBe(path.join(dir, 'app.config.ts'));
    expect(await readAppJson(dir)).toBeUndefined();
  });

  it('reads app.json', async () => {
    const dir = await project({ 'app.json': JSON.stringify({ expo: { slug: 'demo' } }) });
    expect(await readAppJson(dir)).toEqual({ expo: { slug: 'demo' } });
  });
});
