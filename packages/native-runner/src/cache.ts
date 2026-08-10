/**
 * A built artifact per commit, kept outside the worktrees.
 *
 * Worktrees are transient — created for a candidate, removed the moment it is
 * classified — so anything expensive built inside one is gone by the next
 * round. That matters more here than for a JS swap: a resumed run, a retry
 * after an inconclusive verdict, and the final "last good vs first bad"
 * comparison all want a commit that was already built. A commit's source is
 * fully determined by its SHA, so the SHA plus the build parameters is the key.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Platform } from '@mobile-bisect/core';

export interface CacheKey {
  sha: string;
  platform: Platform;
  /** Everything that changes the output: scheme, configuration, variant, sdk. */
  params: Record<string, string | undefined>;
}

export interface CachedBuild {
  /** Absolute path to the artifact. */
  appPath: string;
  bundleId?: string;
  /** Set once the runtime has ingested this artifact, so a resume skips upload. */
  buildId?: string;
  builtAt: string;
  buildMs?: number;
}

interface CacheEntryFile extends Omit<CachedBuild, 'appPath'> {
  version: 1;
  artifact: string;
}

export class BuildCache {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** `<root>/<platform>/<slug>/<sha>` — one directory per commit per config. */
  dirFor(key: CacheKey): string {
    return path.join(this.root, key.platform, slug(key.params), key.sha);
  }

  async get(key: CacheKey): Promise<CachedBuild | undefined> {
    const dir = this.dirFor(key);
    const entry = await readJson(path.join(dir, 'entry.json'));
    if (!entry) return undefined;

    const appPath = path.isAbsolute(entry.artifact)
      ? entry.artifact
      : path.join(dir, entry.artifact);
    if (!(await exists(appPath))) return undefined;

    return {
      appPath,
      bundleId: entry.bundleId,
      buildId: entry.buildId,
      builtAt: entry.builtAt,
      buildMs: entry.buildMs,
    };
  }

  /** Where the adapter should place the artifact it is about to produce. */
  async stagingDir(key: CacheKey): Promise<string> {
    const dir = this.dirFor(key);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async put(key: CacheKey, build: CachedBuild): Promise<CachedBuild> {
    const dir = await this.stagingDir(key);
    const entry: CacheEntryFile = {
      version: 1,
      artifact: path.relative(dir, build.appPath),
      bundleId: build.bundleId,
      buildId: build.buildId,
      builtAt: build.builtAt,
      buildMs: build.buildMs,
    };
    await writeJson(path.join(dir, 'entry.json'), entry);
    return build;
  }

  /** Remember the runtime's id for an artifact we already have on disk. */
  async noteBuildId(key: CacheKey, buildId: string): Promise<void> {
    const dir = this.dirFor(key);
    const entry = await readJson(path.join(dir, 'entry.json'));
    if (!entry) return;
    await writeJson(path.join(dir, 'entry.json'), { ...entry, buildId });
  }

  async evict(key: CacheKey): Promise<void> {
    await rm(this.dirFor(key), { recursive: true, force: true });
  }

  /**
   * Keeps the `keep` most recently built commits for a config and drops the
   * rest. A 64-commit range only ever builds ~6 of them, but a repo that gets
   * bisected weekly would otherwise accumulate gigabytes of stale `.app.zip`.
   */
  async prune(key: Pick<CacheKey, 'platform' | 'params'>, keep: number): Promise<string[]> {
    const parent = path.join(this.root, key.platform, slug(key.params));
    const shas = await listDir(parent);
    const dated: Array<{ dir: string; at: number }> = [];
    for (const sha of shas) {
      const dir = path.join(parent, sha);
      const entry = await readJson(path.join(dir, 'entry.json'));
      const at = entry ? Date.parse(entry.builtAt) : await mtimeOf(dir);
      dated.push({ dir, at: Number.isNaN(at) ? 0 : at });
    }
    dated.sort((a, b) => b.at - a.at);
    const doomed = dated.slice(keep);
    for (const d of doomed) await rm(d.dir, { recursive: true, force: true });
    return doomed.map((d) => d.dir);
  }
}

/** Stable, filesystem-safe, and readable in a `ls` — debuggability beats brevity. */
export function slug(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}-${sanitise(v)}`);
  return parts.length > 0 ? parts.join('_') : 'default';
}

function sanitise(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

// ---------------------------------------------------------------------------

async function readJson(file: string): Promise<CacheEntryFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as CacheEntryFile;
    return parsed?.version === 1 && typeof parsed.artifact === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: CacheEntryFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}
