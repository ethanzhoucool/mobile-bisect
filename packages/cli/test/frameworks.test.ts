import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createAdapter, createFakeAdapter, detectFrameworks, resolveAdapter } from '../src/frameworks.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-frameworks-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expoProject(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'orbit', dependencies: { expo: '~52.0.0' } }),
    'utf8',
  );
  return dir;
}

async function xcodeProject(dir: string, scheme = 'Orbit'): Promise<string> {
  const proj = path.join(dir, `${scheme}.xcodeproj`, 'xcshareddata', 'xcschemes');
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, `${scheme}.xcscheme`), '<Scheme/>', 'utf8');
  await writeFile(path.join(dir, `${scheme}.xcodeproj`, 'project.pbxproj'), '// objects', 'utf8');
  return dir;
}

async function gradleProject(dir: string): Promise<string> {
  await mkdir(path.join(dir, 'app'), { recursive: true });
  await writeFile(path.join(dir, 'settings.gradle'), "include ':app'", 'utf8');
  await writeFile(path.join(dir, 'gradlew'), '#!/bin/sh', 'utf8');
  await writeFile(path.join(dir, 'app', 'build.gradle'), 'android {}', 'utf8');
  return dir;
}

describe('detectFrameworks', () => {
  it('picks Expo for an Expo project', async () => {
    const dir = await expoProject(path.join(root, 'expo'));
    const summary = await detectFrameworks({ projectRoot: dir, config: {} });

    expect(summary.picked?.name).toBe('expo');
    expect(summary.picked?.adapter.candidateKind).toBe('bundle');
  });

  it('picks Xcode for a Swift app', async () => {
    const dir = await xcodeProject(path.join(root, 'swift'));
    const summary = await detectFrameworks({ projectRoot: dir, config: {} });

    expect(summary.picked?.name).toBe('xcode');
    expect(summary.picked?.adapter.candidateKind).toBe('binary');
    expect(summary.picked?.detection.platforms).toEqual(['ios']);
  });

  it('picks Gradle for a Kotlin app', async () => {
    const dir = await gradleProject(path.join(root, 'kotlin'));
    const summary = await detectFrameworks({ projectRoot: dir, config: {} });

    expect(summary.picked?.name).toBe('gradle');
    expect(summary.picked?.detection.platforms).toEqual(['android']);
  });

  it('prefers Expo over Xcode on a prebuilt Expo app, because a JS swap is faster', async () => {
    const dir = await expoProject(path.join(root, 'prebuilt'));
    await xcodeProject(path.join(dir, 'ios'));
    await gradleProject(path.join(dir, 'android'));

    const summary = await detectFrameworks({ projectRoot: dir, config: {} });
    expect(summary.picked?.name).toBe('expo');
  });

  it('falls through to the native adapters for a bare React Native app', async () => {
    const dir = path.join(root, 'bare');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'orbit', dependencies: { 'react-native': '0.76.0' } }),
      'utf8',
    );
    await xcodeProject(path.join(dir, 'ios'));

    const summary = await detectFrameworks({ projectRoot: dir, config: {} });
    expect(summary.picked?.name).toBe('xcode');
  });

  it('reports every verdict, so a project that matched nothing can be explained', async () => {
    const dir = path.join(root, 'nothing');
    await mkdir(dir, { recursive: true });

    const summary = await detectFrameworks({ projectRoot: dir, config: {} });
    expect(summary.picked).toBeUndefined();
    expect(summary.considered.map((c) => c.name).sort()).toEqual(['expo', 'gradle', 'xcode']);
    for (const c of summary.considered) expect(c.detection.reason).toBeTruthy();
  });
});

describe('resolveAdapter', () => {
  it('obeys an explicit framework even when detection would pick another', async () => {
    const dir = await expoProject(path.join(root, 'both'));
    await xcodeProject(path.join(dir, 'ios'));

    const resolved = await resolveAdapter('xcode', { projectRoot: dir, config: {} });
    expect(resolved.name).toBe('xcode');
    expect(resolved.detection.ok).toBe(true);
  });

  it('explains itself when nothing matches instead of guessing', async () => {
    const dir = path.join(root, 'empty');
    await mkdir(dir, { recursive: true });

    await expect(resolveAdapter(undefined, { projectRoot: dir, config: {} })).rejects.toThrow(
      /Could not tell what kind of mobile app/,
    );
  });
});

describe('config reaches the adapter', () => {
  it('passes build.scheme through, so an ambiguous project becomes buildable', async () => {
    const dir = await xcodeProject(path.join(root, 'multi'), 'Orbit');
    await writeFile(
      path.join(dir, 'Orbit.xcodeproj', 'xcshareddata', 'xcschemes', 'OrbitStaging.xcscheme'),
      '<Scheme/>',
      'utf8',
    );

    const undecided = await detectFrameworks({ projectRoot: dir, config: {} });
    expect(undecided.picked).toBeUndefined();

    const decided = await detectFrameworks({
      projectRoot: dir,
      config: { build: { scheme: 'Orbit' } },
    });
    expect(decided.picked?.name).toBe('xcode');
  });

  it('passes build.module through for Gradle', async () => {
    const dir = path.join(root, 'odd');
    await mkdir(path.join(dir, 'phone'), { recursive: true });
    await writeFile(path.join(dir, 'settings.gradle'), "include ':phone'\ninclude ':wear'", 'utf8');

    const decided = await detectFrameworks({
      projectRoot: dir,
      config: { build: { module: 'phone' } },
    });
    expect(decided.picked?.name).toBe('gradle');
  });
});

describe('createAdapter', () => {
  it('builds each adapter by name', async () => {
    for (const name of ['expo', 'xcode', 'gradle'] as const) {
      const adapter = await createAdapter(name, { projectRoot: root, config: {} });
      expect(adapter.name).toBe(name);
    }
  });

  it('says which package is missing when one cannot be loaded', async () => {
    process.env.MOBILE_BISECT_FALLBACK = '1';
    try {
      await expect(createAdapter('xcode', { projectRoot: root, config: {} })).rejects.toThrow(
        /native-runner/,
      );
    } finally {
      delete process.env.MOBILE_BISECT_FALLBACK;
    }
  });
});

describe('--framework parsing', () => {
  const run = (extra: string[]) =>
    parseArgs(['run', '--good', 'v1', '--bad', 'HEAD', ...extra], '/tmp');

  it('accepts the three adapter names', () => {
    for (const name of ['expo', 'xcode', 'gradle']) {
      expect(run(['--framework', name])).toMatchObject({ framework: name });
    }
  });

  it('accepts the platform words people actually type', () => {
    expect(run(['--framework', 'ios'])).toMatchObject({ framework: 'xcode' });
    expect(run(['--framework', 'swift'])).toMatchObject({ framework: 'xcode' });
    expect(run(['--framework', 'android'])).toMatchObject({ framework: 'gradle' });
    expect(run(['--framework', 'kotlin'])).toMatchObject({ framework: 'gradle' });
  });

  it('treats auto as "detect it"', () => {
    expect(run(['--framework', 'auto'])).toMatchObject({ framework: undefined });
  });

  it('rejects an unknown framework with the supported list', () => {
    expect(() => run(['--framework', 'unity'])).toThrow(/expo, xcode or gradle/);
  });

  it('carries the build flags through', () => {
    expect(run(['--scheme', 'Orbit', '--variant', 'freeDebug', '--project-dir', 'ios'])).toMatchObject(
      { scheme: 'Orbit', variant: 'freeDebug', projectDir: 'ios' },
    );
  });
});

describe('the dry-run adapter', () => {
  it('prepares candidates with no toolchain at all', async () => {
    const adapter = createFakeAdapter();
    const candidate = await adapter.prepare('a'.repeat(40), root, { platform: 'ios' });

    expect(candidate.kind).toBe('bundle');
    await expect(candidate.dispose()).resolves.toBeUndefined();
  });
});
