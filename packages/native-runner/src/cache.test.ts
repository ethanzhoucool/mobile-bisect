import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildCache, slug, type CacheKey } from './cache.js';

let root: string;
let cache: BuildCache;

const KEY: CacheKey = {
  sha: 'a'.repeat(40),
  platform: 'ios',
  params: { scheme: 'Orbit', configuration: 'Debug' },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-cache-'));
  cache = new BuildCache(path.join(root, 'artifacts'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function store(key: CacheKey, name = 'Orbit.app.zip'): Promise<string> {
  const dir = await cache.stagingDir(key);
  const appPath = path.join(dir, name);
  await writeFile(appPath, 'PK', 'utf8');
  await cache.put(key, { appPath, bundleId: 'com.orbit.store', builtAt: new Date(0).toISOString() });
  return appPath;
}

describe('BuildCache', () => {
  it('is empty before anything is stored', async () => {
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('round-trips an artifact', async () => {
    const appPath = await store(KEY);
    const hit = await cache.get(KEY);

    expect(hit?.appPath).toBe(appPath);
    expect(hit?.bundleId).toBe('com.orbit.store');
  });

  it('misses when the artifact was deleted out from under it', async () => {
    const appPath = await store(KEY);
    await rm(appPath);

    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('separates commits', async () => {
    await store(KEY);
    const other = { ...KEY, sha: 'b'.repeat(40) };

    expect(await cache.get(other)).toBeUndefined();
  });

  it('separates build parameters, so a Release build never masquerades as Debug', async () => {
    await store(KEY);
    const release = { ...KEY, params: { ...KEY.params, configuration: 'Release' } };

    expect(await cache.get(release)).toBeUndefined();
  });

  it('remembers an uploaded build id without rebuilding', async () => {
    await store(KEY);
    await cache.noteBuildId(KEY, 'build_123');

    expect((await cache.get(KEY))?.buildId).toBe('build_123');
  });

  it('ignores noteBuildId for something it never built', async () => {
    await expect(cache.noteBuildId(KEY, 'build_123')).resolves.toBeUndefined();
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('evicts on request', async () => {
    await store(KEY);
    await cache.evict(KEY);
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('prunes the oldest builds and keeps the newest', async () => {
    for (let i = 0; i < 5; i++) {
      const key = { ...KEY, sha: String(i).repeat(40) };
      const dir = await cache.stagingDir(key);
      const appPath = path.join(dir, 'Orbit.app.zip');
      await writeFile(appPath, 'PK', 'utf8');
      await cache.put(key, { appPath, builtAt: new Date(i * 1000).toISOString() });
    }

    const removed = await cache.prune({ platform: 'ios', params: KEY.params }, 2);

    expect(removed).toHaveLength(3);
    expect(await cache.get({ ...KEY, sha: '4'.repeat(40) })).toBeDefined();
    expect(await cache.get({ ...KEY, sha: '0'.repeat(40) })).toBeUndefined();
  });

  it('prunes nothing when the cache is already under the limit', async () => {
    await store(KEY);
    expect(await cache.prune({ platform: 'ios', params: KEY.params }, 10)).toEqual([]);
  });
});

describe('slug', () => {
  it('is stable regardless of key order', () => {
    expect(slug({ b: '2', a: '1' })).toBe(slug({ a: '1', b: '2' }));
  });

  it('drops empty values so an unset option does not change the key', () => {
    expect(slug({ scheme: 'Orbit', sdk: undefined })).toBe('scheme-Orbit');
  });

  it('makes values safe for a directory name', () => {
    expect(slug({ dest: 'generic/platform=iOS Simulator' })).not.toMatch(/[/=\s]/);
  });

  it('has a name for the empty case', () => {
    expect(slug({})).toBe('default');
  });
});
