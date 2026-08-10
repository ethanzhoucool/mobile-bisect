import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MissingLockfileError,
  cloneTree,
  detectPackageManager,
  installCommandFor,
  lockfileCacheKey,
  nodeMajor,
  type PackageManager,
} from './deps.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-deps-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('detectPackageManager', () => {
  const cases: Array<[string, PackageManager]> = [
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ];

  it.each(cases)('%s -> %s', async (lockfile, manager) => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, lockfile), 'lock');
    const detected = await detectPackageManager(dir);
    expect(detected.manager).toBe(manager);
    expect(detected.lockfile).toBe(lockfile);
    expect(detected.lockfilePath).toBe(path.join(dir, lockfile));
  });

  it('names all four lockfiles when none is present', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    await expect(detectPackageManager(dir)).rejects.toBeInstanceOf(MissingLockfileError);
    await expect(detectPackageManager(dir)).rejects.toThrow(
      /package-lock\.json, yarn\.lock, pnpm-lock\.yaml, bun\.lockb, bun\.lock/,
    );
  });
});

describe('installCommandFor', () => {
  const cache = '/cache';

  it('builds argv arrays, never shell strings', () => {
    expect(installCommandFor('npm', cache)).toEqual({
      command: 'npm',
      args: ['ci', '--cache', path.join(cache, 'npm')],
      env: {},
    });
    expect(installCommandFor('yarn', cache)).toEqual({
      command: 'yarn',
      args: ['install', '--frozen-lockfile'],
      env: { YARN_CACHE_FOLDER: path.join(cache, 'yarn') },
    });
    expect(installCommandFor('pnpm', cache)).toEqual({
      command: 'pnpm',
      args: ['install', '--frozen-lockfile', '--store-dir', path.join(cache, 'pnpm')],
      env: {},
    });
    expect(installCommandFor('bun', cache)).toEqual({
      command: 'bun',
      args: ['install', '--frozen-lockfile'],
      env: { BUN_INSTALL_CACHE_DIR: path.join(cache, 'bun') },
    });
  });

  it('keeps a hostile cache path inside one argv element', () => {
    const cmd = installCommandFor('npm', '/tmp/x; rm -rf ~');
    expect(cmd.args).toHaveLength(3);
    expect(cmd.args[2]).toBe(path.join('/tmp/x; rm -rf ~', 'npm'));
  });

  it('every manager installs strictly from the lockfile', () => {
    const managers: PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];
    for (const m of managers) {
      const { args } = installCommandFor(m, cache);
      expect(args.some((a) => a === 'ci' || a === '--frozen-lockfile')).toBe(true);
    }
  });
});

describe('lockfileCacheKey', () => {
  const bytes = Buffer.from('lockfile contents\n');

  it('is stable for identical input', () => {
    const a = lockfileCacheKey({ lockfileBytes: bytes, manager: 'npm', nodeMajor: 22 });
    const b = lockfileCacheKey({ lockfileBytes: Buffer.from(bytes), manager: 'npm', nodeMajor: 22 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes with the lockfile bytes', () => {
    const a = lockfileCacheKey({ lockfileBytes: bytes, manager: 'npm', nodeMajor: 22 });
    const b = lockfileCacheKey({ lockfileBytes: Buffer.from('other\n'), manager: 'npm', nodeMajor: 22 });
    expect(a).not.toBe(b);
  });

  it('changes with the package manager', () => {
    const a = lockfileCacheKey({ lockfileBytes: bytes, manager: 'npm', nodeMajor: 22 });
    const b = lockfileCacheKey({ lockfileBytes: bytes, manager: 'pnpm', nodeMajor: 22 });
    expect(a).not.toBe(b);
  });

  it('changes with the node major (native addons are ABI-bound)', () => {
    const a = lockfileCacheKey({ lockfileBytes: bytes, manager: 'npm', nodeMajor: 20 });
    const b = lockfileCacheKey({ lockfileBytes: bytes, manager: 'npm', nodeMajor: 22 });
    expect(a).not.toBe(b);
  });

  it('accepts a string identically to its bytes', () => {
    const a = lockfileCacheKey({ lockfileBytes: 'abc', manager: 'yarn', nodeMajor: 18 });
    const b = lockfileCacheKey({ lockfileBytes: Buffer.from('abc'), manager: 'yarn', nodeMajor: 18 });
    expect(a).toBe(b);
  });
});

describe('nodeMajor', () => {
  it.each([
    ['v22.11.0', 22],
    ['v18.20.4', 18],
  ])('%s -> %i', (v, expected) => expect(nodeMajor(v)).toBe(expected));
});

describe('cloneTree', () => {
  it('restores a tree and survives an existing destination', async () => {
    const root = await tmpDir();
    const src = path.join(root, 'node_modules');
    await fs.mkdir(path.join(src, 'pkg-a'), { recursive: true });
    await fs.writeFile(path.join(src, 'pkg-a', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(src, '.package-lock.json'), '{}');

    const dest = path.join(root, 'restored');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'stale.txt'), 'stale');

    const strategy = await cloneTree(src, dest);
    expect(['clonefile', 'hardlink', 'copy']).toContain(strategy);
    expect(await fs.readFile(path.join(dest, 'pkg-a', 'index.js'), 'utf8')).toBe('module.exports = 1;');
    await expect(fs.stat(path.join(dest, 'stale.txt'))).rejects.toThrow();
    expect((await fs.readdir(dest)).sort()).toEqual(['.package-lock.json', 'pkg-a']);
  });

  it('fails loudly when the source does not exist', async () => {
    const root = await tmpDir();
    await expect(cloneTree(path.join(root, 'missing'), path.join(root, 'dest'))).rejects.toThrow(
      /failed to clone/,
    );
  });
});
