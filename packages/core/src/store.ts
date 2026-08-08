/**
 * Run persistence: `.expo-bisect/runs/<run-id>/{state.json,events.jsonl,artifacts/}`.
 *
 * events.jsonl is append-only and serialized through an in-process queue so
 * concurrent `append()` calls can never interleave a partial line. state.json is
 * written temp-then-rename, so a reader never sees a torn file.
 */

import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { redactValue } from './redact.js';
import type { BisectEvent, BisectState } from './types.js';

export const RUNS_DIRNAME = path.join('.expo-bisect', 'runs');

export class RunStore {
  readonly dir: string;
  readonly artifactsDir: string;
  readonly runId: string;

  private queue: Promise<void> = Promise.resolve();

  private constructor(dir: string, runId: string) {
    this.dir = dir;
    this.runId = runId;
    this.artifactsDir = path.join(dir, 'artifacts');
  }

  static async create(cwd: string, runId: string): Promise<RunStore> {
    const store = new RunStore(runDir(cwd, runId), safeRunId(runId));
    await fs.mkdir(store.artifactsDir, { recursive: true });
    // Touch the log so `readEvents()` on a fresh run returns [] instead of ENOENT.
    const fh = await fs.open(store.eventsPath, 'a');
    await fh.close();
    return store;
  }

  static async open(cwd: string, runId: string): Promise<RunStore> {
    const dir = runDir(cwd, runId);
    try {
      await fs.access(dir, fsc.R_OK);
    } catch {
      throw new Error(`run "${runId}" not found at ${dir}`);
    }
    const store = new RunStore(dir, safeRunId(runId));
    await fs.mkdir(store.artifactsDir, { recursive: true });
    return store;
  }

  static async list(cwd: string): Promise<string[]> {
    const root = path.join(cwd, RUNS_DIRNAME);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /** Most recently touched run, or null when none exist. */
  static async latest(cwd: string): Promise<RunStore | null> {
    const ids = await RunStore.list(cwd);
    if (ids.length === 0) return null;
    let best: { id: string; mtime: number } | null = null;
    for (const id of ids) {
      const dir = runDir(cwd, id);
      const mtime = await newestMtime([
        dir,
        path.join(dir, 'events.jsonl'),
        path.join(dir, 'state.json'),
      ]);
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    return best ? RunStore.open(cwd, best.id) : null;
  }

  get eventsPath(): string {
    return path.join(this.dir, 'events.jsonl');
  }

  get statePath(): string {
    return path.join(this.dir, 'state.json');
  }

  /** Atomic append of one JSONL record. Serialized against other appends. */
  append(e: BisectEvent): Promise<void> {
    const line = JSON.stringify(redactValue(e)) + '\n';
    const next = this.queue.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.eventsPath, line, 'utf8');
    });
    // Keep the chain alive even if one append rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async readEvents(): Promise<BisectEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.eventsPath, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n');
    const out: BisectEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as BisectEvent);
      } catch (err) {
        // Tolerate only a torn final line (killed mid-write); anything else is corruption.
        if (i === lines.length - 1) break;
        throw new Error(`${this.eventsPath}:${i + 1} is not valid JSON: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Write-temp-then-rename so readers never observe a partial state.json. */
  async saveState(s: BisectState): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const body = JSON.stringify(redactValue(s), null, 2) + '\n';
    const tmp = path.join(this.dir, `.state.json.${process.pid}.${rand()}.tmp`);
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.statePath);
  }

  async loadState(): Promise<BisectState | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      return JSON.parse(raw) as BisectState;
    } catch {
      return null;
    }
  }
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_DIRNAME, safeRunId(runId));
}

/** Run ids land on disk as a directory name, so keep them path-safe. */
function safeRunId(runId: string): string {
  if (!runId || runId === '.' || runId === '..') throw new Error(`invalid run id: "${runId}"`);
  if (/[/\\\0]/.test(runId)) throw new Error(`run id must not contain path separators: "${runId}"`);
  return runId;
}

async function newestMtime(paths: string[]): Promise<number> {
  let newest = 0;
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* missing files simply don't count */
    }
  }
  return newest;
}

function rand(): string {
  return createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8);
}
