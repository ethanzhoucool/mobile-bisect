/**
 * Dependency install for a candidate worktree.
 *
 * Six candidates must not mean six cold installs, so `node_modules` is cached
 * by a content hash of the lockfile and restored with a CoW/hardlink clone.
 * Installs are strictly lockfile-pinned: a bisect over floating deps would
 * attribute a regression to the wrong commit.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/** Lockfile -> manager, in probe order. */
export const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
];

export interface DetectedPackageManager {
  manager: PackageManager;
  /** Lockfile basename. */
  lockfile: string;
  /** Absolute path to the lockfile. */
  lockfilePath: string;
}

export class MissingLockfileError extends Error {
  readonly worktreePath: string;
  readonly lookedFor: string[];

  constructor(worktreePath: string) {
    const names = LOCKFILES.map((l) => l.file);
    super(
      `no lockfile in ${worktreePath}. Looked for: ${names.join(', ')}. ` +
        'mobile-bisect installs strictly from a lockfile — bisecting over unpinned dependencies ' +
        'would blame the wrong commit. Commit a lockfile and re-run.',
    );
    this.name = 'MissingLockfileError';
    this.worktreePath = worktreePath;
    this.lookedFor = names;
  }
}

export async function detectPackageManager(worktreePath: string): Promise<DetectedPackageManager> {
  for (const { file, manager } of LOCKFILES) {
    const lockfilePath = path.join(worktreePath, file);
    if (await isFile(lockfilePath)) return { manager, lockfile: file, lockfilePath };
  }
  throw new MissingLockfileError(worktreePath);
}

// ---------------------------------------------------------------------------
// Install commands — argv arrays only, never a shell string
// ---------------------------------------------------------------------------

export interface InstallCommand {
  command: string;
  args: string[];
  /** Extra env for managers whose cache is env-configured. */
  env: Record<string, string>;
}

export function installCommandFor(manager: PackageManager, cacheDir: string): InstallCommand {
  switch (manager) {
    case 'npm':
      return { command: 'npm', args: ['ci', '--cache', path.join(cacheDir, 'npm')], env: {} };
    case 'yarn':
      return {
        command: 'yarn',
        args: ['install', '--frozen-lockfile'],
        env: { YARN_CACHE_FOLDER: path.join(cacheDir, 'yarn') },
      };
    case 'pnpm':
      return {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--store-dir', path.join(cacheDir, 'pnpm')],
        env: {},
      };
    case 'bun':
      return {
        command: 'bun',
        args: ['install', '--frozen-lockfile'],
        env: { BUN_INSTALL_CACHE_DIR: path.join(cacheDir, 'bun') },
      };
  }
}

// ---------------------------------------------------------------------------
// Content-hash cache key
// ---------------------------------------------------------------------------

export interface CacheKeyInput {
  lockfileBytes: Uint8Array | string;
  manager: PackageManager;
  /** Node major, because native addons are ABI-bound to it. */
  nodeMajor: number;
}

export function lockfileCacheKey(input: CacheKeyInput): string {
  const h = createHash('sha256');
  h.update(`mobile-bisect/nm/1\n${input.manager}\nnode${input.nodeMajor}\n`);
  h.update(typeof input.lockfileBytes === 'string' ? Buffer.from(input.lockfileBytes) : input.lockfileBytes);
  return h.digest('hex').slice(0, 32);
}

export function nodeMajor(version: string = process.version): number {
  const m = /(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// installDeps
// ---------------------------------------------------------------------------

export interface InstallDepsOptions {
  onLog?: (line: string) => void;
  /** Default 15 minutes; a cold npm ci on a big app is slow. */
  timeoutMs?: number;
  /** Skip the shared node_modules cache (useful when debugging). */
  useCache?: boolean;
}

export async function installDeps(
  worktreePath: string,
  cacheDir: string,
  opts: InstallDepsOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const detected = await detectPackageManager(worktreePath);
  const bytes = await fs.readFile(detected.lockfilePath);
  const key = lockfileCacheKey({ lockfileBytes: bytes, manager: detected.manager, nodeMajor: nodeMajor() });

  const nmRoot = path.join(cacheDir, 'nm');
  const entry = path.join(nmRoot, key);
  const dest = path.join(worktreePath, 'node_modules');
  await fs.mkdir(nmRoot, { recursive: true });

  if ((opts.useCache ?? true) && (await isDir(entry))) {
    log(`node_modules cache hit (${detected.manager} ${key.slice(0, 8)})`);
    await cloneTree(entry, dest);
    return;
  }

  const cmd = installCommandFor(detected.manager, cacheDir);
  log(`${cmd.command} ${cmd.args.join(' ')} (cwd ${worktreePath})`);
  try {
    await execFileAsync(cmd.command, cmd.args, {
      cwd: worktreePath,
      env: { ...process.env, ...cmd.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
      timeout: opts.timeoutMs ?? 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `${cmd.command} ${cmd.args.join(' ')} failed in ${worktreePath}: ${describe(err)}`,
      { cause: err },
    );
  }

  if (!(await isDir(dest))) {
    throw new Error(`${cmd.command} completed but ${dest} does not exist`);
  }
  if (opts.useCache ?? true) await seedCache(dest, entry, log);
}

/** Copy a fresh node_modules into the cache under a temp name, then rename. */
async function seedCache(source: string, entry: string, log: (line: string) => void): Promise<void> {
  const tmp = `${entry}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await cloneTree(source, tmp);
    await fs.rename(tmp, entry);
    log(`seeded node_modules cache ${path.basename(entry).slice(0, 8)}`);
  } catch (err) {
    // A concurrent candidate got there first, or the disk is full: the install
    // already succeeded, so a failed seed must never fail the candidate.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    log(`node_modules cache seed skipped: ${describe(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Tree cloning
// ---------------------------------------------------------------------------

export type CloneStrategy = 'clonefile' | 'hardlink' | 'copy';

/**
 * macOS gets APFS clonefile (copy-on-write, so a later write in the worktree
 * cannot corrupt the cache); elsewhere hardlinks, which are only safe because
 * a restored tree is never installed into again.
 */
export async function cloneTree(src: string, dest: string): Promise<CloneStrategy> {
  const attempts: Array<{ strategy: CloneStrategy; args: string[] }> =
    process.platform === 'darwin'
      ? [
          { strategy: 'clonefile', args: ['-Rc', src, dest] },
          { strategy: 'copy', args: ['-R', src, dest] },
        ]
      : [
          { strategy: 'hardlink', args: ['-al', src, dest] },
          { strategy: 'copy', args: ['-R', src, dest] },
        ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await execFileAsync('cp', attempt.args, { maxBuffer: 16 * 1024 * 1024 });
      await verifyTree(src, dest);
      return attempt.strategy;
    } catch (err) {
      lastErr = err;
    }
  }
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  throw new Error(`failed to clone ${src} -> ${dest}: ${describe(lastErr)}`, { cause: lastErr });
}

/** Cheap structural check: a truncated clone must not be handed back as valid. */
async function verifyTree(src: string, dest: string): Promise<void> {
  const st = await fs.stat(dest);
  if (!st.isDirectory()) throw new Error(`${dest} is not a directory`);
  const [a, b] = await Promise.all([fs.readdir(src), fs.readdir(dest)]);
  if (a.length !== b.length) {
    throw new Error(`clone is incomplete: ${src} has ${a.length} entries, ${dest} has ${b.length}`);
  }
}

// ---------------------------------------------------------------------------

export function defaultCacheDir(projectRoot?: string): string {
  if (projectRoot) return path.join(projectRoot, '.mobile-bisect', 'cache');
  return path.join(os.tmpdir(), 'mobile-bisect-cache');
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
