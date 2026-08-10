import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpoAdapter } from './adapter.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-expo-adapter-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(dir: string, pkg: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

describe('ExpoAdapter.detect', () => {
  it('claims an Expo project with high confidence', async () => {
    const dir = await project(path.join(root, 'app'), {
      name: 'orbit',
      dependencies: { expo: '~52.0.11', 'expo-router': '3.5.1' },
    });

    const d = await new ExpoAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(true);
    expect(d.summary).toContain('SDK 52.0.11');
    expect(d.summary).toContain('expo-router');
    expect(d.platforms).toEqual(['ios', 'android']);
  });

  it('outranks the native adapters, so a prebuilt Expo app still swaps JS', async () => {
    const dir = await project(path.join(root, 'prebuilt'), {
      name: 'orbit',
      dependencies: { expo: '~52.0.0' },
    });
    await mkdir(path.join(dir, 'ios'), { recursive: true });

    const d = await new ExpoAdapter({ projectRoot: root }).detect(dir);
    // 0.8 is what XcodeAdapter scores a standalone project; nested is 0.55.
    expect(d.confidence).toBeGreaterThan(0.8);
  });

  it('declines a bare React Native project and says why', async () => {
    const dir = await project(path.join(root, 'bare'), {
      name: 'orbit',
      dependencies: { 'react-native': '0.76.0' },
    });

    const d = await new ExpoAdapter({ projectRoot: root }).detect(dir);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/bare React Native/);
  });

  it('declines a directory with no package.json', async () => {
    const d = await new ExpoAdapter({ projectRoot: root }).detect(path.join(root, 'nothing'));
    expect(d.ok).toBe(false);
    expect(d.confidence).toBe(0);
  });
});

describe('ExpoAdapter.precheck', () => {
  it('can be turned off, for a caller that accepts the risk', async () => {
    const adapter = new ExpoAdapter({ projectRoot: root, rejectNativeChanges: false });
    const result = await adapter.precheck({
      projectPath: root,
      goodSha: 'a'.repeat(40),
      badSha: 'b'.repeat(40),
      platform: 'ios',
    });
    expect(result.ok).toBe(true);
  });
});

describe('ExpoAdapter shape', () => {
  it('produces bundle candidates, not binaries', () => {
    expect(new ExpoAdapter({ projectRoot: root }).candidateKind).toBe('bundle');
  });

  it('is named so --framework expo resolves to it', () => {
    expect(new ExpoAdapter({ projectRoot: root }).name).toBe('expo');
  });
});
