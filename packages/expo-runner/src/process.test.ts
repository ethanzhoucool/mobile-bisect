import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProcessGroupRegistry, killProcessGroup, spawnGroup } from './process.js';

/** A child that itself spawns a grandchild, exactly what `npx expo start` does. */
const PARENT_WITH_GRANDCHILD = `
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
process.stdout.write('GRANDCHILD ' + g.pid + '\\n');
setInterval(() => {}, 1e9);
`;

const dirs: string[] = [];

async function scriptFile(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-proc-'));
  dirs.push(dir);
  const file = path.join(dir, 'child.cjs');
  await fs.writeFile(file, source);
  return file;
}

/** Polls `check` until it holds or `timeoutMs` passes; says which, instead of hanging. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** ps, not `kill -0`: the point is to prove the OS no longer lists the pid. */
export function psAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' });
  return (res.stdout ?? '').trim().length > 0;
}

async function waitUntilGone(pids: number[], timeoutMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(psAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    alive = pids.filter(psAlive);
  }
  return alive;
}

async function readGrandchildPid(tail: () => string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = /GRANDCHILD (\d+)/.exec(tail());
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('child never reported a grandchild pid');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('ManagedProcess', () => {
  it('kills the whole process group, leaving no orphan grandchild', async () => {
    const file = await scriptFile(PARENT_WITH_GRANDCHILD);
    const proc = spawnGroup(process.execPath, [file]);
    const grandchild = await readGrandchildPid(() => proc.tail());

    expect(psAlive(proc.pid)).toBe(true);
    expect(psAlive(grandchild)).toBe(true);

    await proc.stop(1_000);

    expect(proc.hasExited).toBe(true);
    expect(await waitUntilGone([proc.pid, grandchild])).toEqual([]);
  }, 30_000);

  it('resolves stop() only after the process has actually exited', async () => {
    // Ignores SIGTERM, so stop() must escalate to SIGKILL before resolving.
    const file = await scriptFile(`
      process.on('SIGTERM', () => {});
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1e9);
    `);
    const proc = spawnGroup(process.execPath, [file]);
    while (!proc.tail().includes('READY')) await new Promise((r) => setTimeout(r, 25));

    const started = Date.now();
    await proc.stop(300);
    expect(proc.hasExited).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await waitUntilGone([proc.pid])).toEqual([]);
  }, 30_000);

  it('is idempotent and safe to stop twice', async () => {
    const file = await scriptFile('setInterval(() => {}, 1e9);');
    const proc = spawnGroup(process.execPath, [file]);
    await Promise.all([proc.stop(500), proc.stop(500)]);
    await proc.stop(500);
    expect(proc.hasExited).toBe(true);
  }, 30_000);

  // stdout and stderr are separate pipes, so the order they are read in is not
  // the order they were written in. A stderr line read before the last stdout
  // chunk is pushed out of a 10-line tail by the stdout lines behind it, so
  // each test waits on a marker from the one stream it writes.
  it('keeps only the last lines of output for diagnostics', async () => {
    const file = await scriptFile(`
      for (let i = 0; i < 200; i++) console.log('line ' + i);
      setInterval(() => {}, 1e9);
    `);
    const proc = spawnGroup(process.execPath, [file], { keepLines: 10 });
    expect(await until(() => proc.tail().includes('line 199'))).toBe(true);
    const tail = proc.tail(10);
    expect(tail.split('\n')).toHaveLength(10);
    expect(tail).toContain('line 190');
    expect(tail).not.toContain('line 189');
    await proc.stop(500);
  }, 30_000);

  it('captures stderr as well as stdout', async () => {
    const file = await scriptFile(`
      console.error('boom');
      setInterval(() => {}, 1e9);
    `);
    const proc = spawnGroup(process.execPath, [file], { keepLines: 10 });
    expect(await until(() => proc.tail().includes('boom'))).toBe(true);
    await proc.stop(500);
  }, 30_000);
});

describe('killProcessGroup', () => {
  it('returns false for a pid that does not exist', () => {
    expect(killProcessGroup(0x7ffffff, 'SIGTERM')).toBe(false);
  });
});

describe('ProcessGroupRegistry', () => {
  it('installs handlers once and removes them on uninstall', () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      beforeExit: process.listenerCount('beforeExit'),
    };
    const registry = new ProcessGroupRegistry();
    registry.install();
    registry.install();
    registry.install();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit + 1);

    registry.uninstall();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit);
  });

  it('stops every tracked group and drops the listeners', async () => {
    const file = await scriptFile(PARENT_WITH_GRANDCHILD);
    const registry = new ProcessGroupRegistry();
    const procs = [spawnGroup(process.execPath, [file]), spawnGroup(process.execPath, [file])];
    for (const p of procs) registry.add(p);
    expect(registry.size).toBe(2);

    const pids = [...procs.map((p) => p.pid)];
    for (const p of procs) pids.push(await readGrandchildPid(() => p.tail()));

    await registry.stopAll(1_000);
    expect(registry.size).toBe(0);
    expect(await waitUntilGone(pids)).toEqual([]);
  }, 30_000);

  it('forgets a process once it exits on its own', async () => {
    const registry = new ProcessGroupRegistry();
    const proc = spawnGroup(process.execPath, ['-e', 'process.exit(0)']);
    registry.add(proc);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.size).toBe(0);
    registry.uninstall();
  }, 30_000);
});
