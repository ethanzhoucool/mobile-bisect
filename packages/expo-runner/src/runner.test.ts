import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ExpoCandidateRunner } from './runner.js';

/**
 * Stand-in for `npx expo start`: answers Metro's /status and spawns a
 * grandchild, so the orphan check exercises the real prepare/dispose path.
 */
const FAKE_METRO = `
const http = require('http');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (!args.includes('--dev-client')) { console.error('missing --dev-client'); process.exit(2); }
if (process.env.CI) { console.error('CI must not be set: it disables Fast Refresh'); process.exit(3); }
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
process.stdout.write('GRANDCHILD ' + g.pid + '\\n');
const server = http.createServer((req, res) => {
  if (req.url === '/status') { res.writeHead(200); res.end('packager-status:running'); }
  else { res.writeHead(404); res.end('nope'); }
});
server.listen(port, () => process.stdout.write('fake metro on ' + port + '\\n'));
setInterval(() => {}, 1e9);
`;

/** Starts, spawns a grandchild, but never binds: readiness must time out. */
const NEVER_READY = `
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
process.stdout.write('GRANDCHILD ' + g.pid + '\\n');
process.stdout.write('Starting Metro Bundler...\\n');
setInterval(() => {}, 1e9);
`;

const dirs: string[] = [];

async function worktree(script: string, appJson?: unknown): Promise<{ dir: string; command: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-runner-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { expo: '~52.0.11' } }),
  );
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify(appJson ?? { expo: { name: 'Demo', slug: 'demo-app', scheme: 'demo' } }),
  );
  const command = path.join(dir, 'fake-expo.cjs');
  await fs.writeFile(command, script);
  return { dir, command };
}

function psAlive(pid: number): boolean {
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

function grandchildPid(tail: string): number {
  const m = /GRANDCHILD (\d+)/.exec(tail);
  if (!m) throw new Error(`no grandchild pid in output:\n${tail}`);
  return Number(m[1]);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('ExpoCandidateRunner (metro mode)', () => {
  it('prepares a candidate and hands back a dev-client deep link', async () => {
    const { dir, command } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      portRange: { min: 42000, max: 42060 },
      expoCommand: { command: process.execPath, args: [command] },
    });

    const prep = await runner.prepare(dir, 'a'.repeat(40));
    try {
      expect(prep.metroPort).toBeGreaterThanOrEqual(42000);
      expect(prep.metroUrl).toBe(`http://127.0.0.1:${prep.metroPort}`);
      expect(prep.bundleUrl).toBe(
        `exp+demo://expo-development-client/?url=${encodeURIComponent(prep.metroUrl!)}`,
      );
      expect(prep.mode).toBe('metro');
    } finally {
      await runner.dispose();
    }
  }, 30_000);

  it('uses the configured host so a cloud device can reach the packager', async () => {
    const { dir, command } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      host: 'relay.tunnel.internal',
      portRange: { min: 42100, max: 42160 },
      expoCommand: { command: process.execPath, args: [command] },
    });
    const prep = await runner.prepare(dir, 'b'.repeat(40));
    try {
      expect(prep.metroUrl).toBe(`http://relay.tunnel.internal:${prep.metroPort}`);
      expect(prep.bundleUrl).toContain('relay.tunnel.internal');
    } finally {
      await runner.dispose();
    }
  }, 30_000);

  it('falls back to expo.slug when no scheme is declared', async () => {
    const { dir, command } = await worktree(FAKE_METRO, { expo: { slug: 'slug-only' } });
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      portRange: { min: 42200, max: 42260 },
      expoCommand: { command: process.execPath, args: [command] },
    });
    const prep = await runner.prepare(dir, 'c'.repeat(40));
    try {
      expect(prep.bundleUrl).toMatch(/^exp\+slug-only:\/\/expo-development-client/);
    } finally {
      await runner.dispose();
    }
  }, 30_000);

  it('leaves no orphan process after dispose', async () => {
    const { dir, command } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      portRange: { min: 42300, max: 42360 },
      expoCommand: { command: process.execPath, args: [command] },
    });

    await runner.prepare(dir, 'd'.repeat(40));
    const [proc] = runner.liveProcesses;
    expect(proc).toBeDefined();
    const pids = [proc.pid, grandchildPid(proc.tail())];
    expect(pids.every(psAlive)).toBe(true);

    await runner.dispose();
    expect(await waitUntilGone(pids)).toEqual([]);
    expect(runner.liveProcesses).toEqual([]);
  }, 30_000);

  it('gives concurrent candidates distinct ports and disposes them all', async () => {
    const { dir, command } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      portRange: { min: 42400, max: 42460 },
      expoCommand: { command: process.execPath, args: [command] },
    });

    const preps = await Promise.all(
      ['1', '2', '3', '4'].map((n) => runner.prepare(dir, n.repeat(40))),
    );
    const ports = preps.map((p) => p.metroPort);
    expect(new Set(ports).size).toBe(4);

    const pids = runner.liveProcesses.flatMap((p) => [p.pid, grandchildPid(p.tail())]);
    expect(pids).toHaveLength(8);

    await runner.dispose();
    expect(await waitUntilGone(pids)).toEqual([]);
  }, 60_000);

  it('cleans up its own child when readiness times out', async () => {
    const { dir, command } = await worktree(NEVER_READY);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      readyTimeoutMs: 1_500,
      portRange: { min: 42500, max: 42560 },
      expoCommand: { command: process.execPath, args: [command] },
    });

    let pids: number[] = [];
    const watcher = setInterval(() => {
      const [proc] = runner.liveProcesses;
      if (proc && pids.length === 0) {
        const m = /GRANDCHILD (\d+)/.exec(proc.tail());
        if (m) pids = [proc.pid, Number(m[1])];
      }
    }, 50);

    await expect(runner.prepare(dir, 'e'.repeat(40))).rejects.toThrow(/not ready on port/);
    clearInterval(watcher);

    expect(pids).toHaveLength(2);
    expect(await waitUntilGone(pids)).toEqual([]);
    expect(runner.liveProcesses).toEqual([]);

    // The port must go back to the pool, not leak for the rest of the bisect.
    const prep = await runner
      .prepare(dir, 'f'.repeat(40))
      .catch((err: Error) => err);
    expect(prep).toBeInstanceOf(Error);
    expect((prep as Error).message).toMatch(/not ready on port 42500/);
    await runner.dispose();
  }, 30_000);

  it('surfaces the CLI output when the child dies early', async () => {
    const { dir, command } = await worktree(`
      process.stdout.write('Error: Cannot find module expo/AppEntry\\n');
      process.exit(1);
    `);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      readyTimeoutMs: 5_000,
      portRange: { min: 42600, max: 42660 },
      expoCommand: { command: process.execPath, args: [command] },
    });
    await expect(runner.prepare(dir, 'g'.repeat(40))).rejects.toThrow(/Cannot find module expo\/AppEntry/);
    await runner.dispose();
  }, 30_000);

  it('refuses a worktree that is not an Expo project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-runner-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    const runner = new ExpoCandidateRunner({ projectRoot: dir, install: false });
    await expect(runner.prepare(dir, 'h'.repeat(40))).rejects.toThrow(/no "expo" dependency/);
    await runner.dispose();
  }, 30_000);

  it('rejects prepare() after dispose', async () => {
    const { dir } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({ projectRoot: dir, install: false });
    await runner.dispose();
    await expect(runner.prepare(dir, 'i'.repeat(40))).rejects.toThrow(/has been disposed/);
  });

  it('has an idempotent per-prep dispose', async () => {
    const { dir, command } = await worktree(FAKE_METRO);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      install: false,
      portRange: { min: 42700, max: 42760 },
      expoCommand: { command: process.execPath, args: [command] },
    });
    const prep = await runner.prepare(dir, 'j'.repeat(40));
    await Promise.all([prep.dispose(), prep.dispose()]);
    await prep.dispose();
    await runner.dispose();
    expect(runner.liveProcesses).toEqual([]);
  }, 30_000);
});

describe('ExpoCandidateRunner (export mode)', () => {
  it('serves the export output and cleans up on dispose', async () => {
    const { dir } = await worktree(FAKE_METRO);
    const exporter = path.join(dir, 'fake-export.cjs');
    await fs.writeFile(
      exporter,
      `
      const fs = require('fs');
      const path = require('path');
      const args = process.argv.slice(2);
      const out = args[args.indexOf('--output-dir') + 1];
      if (args[args.indexOf('--platform') + 1] !== 'ios') process.exit(4);
      fs.mkdirSync(path.join(out, '_expo', 'static', 'js', 'ios'), { recursive: true });
      fs.writeFileSync(path.join(out, 'metadata.json'), JSON.stringify({ version: 0 }));
      fs.writeFileSync(path.join(out, '_expo', 'static', 'js', 'ios', 'index.hbc'), 'BUNDLE');
      `,
    );

    const cacheDir = path.join(dir, '.cache');
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      mode: 'export',
      cacheDir,
      install: false,
      portRange: { min: 42800, max: 42860 },
      expoCommand: { command: process.execPath, args: [exporter] },
    });

    const prep = await runner.prepare(dir, 'k'.repeat(40));
    try {
      expect(prep.mode).toBe('export');
      expect(prep.exportDir).toBe(path.join(cacheDir, 'exports', 'k'.repeat(40)));
      expect(prep.bundleUrl).toBe(`http://127.0.0.1:${prep.metroPort}/`);

      const res = await fetch(`${prep.bundleUrl}metadata.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 0 });

      const bundle = await fetch(`${prep.bundleUrl}_expo/static/js/ios/index.hbc`);
      expect(await bundle.text()).toBe('BUNDLE');

      const escape = await fetch(`http://127.0.0.1:${prep.metroPort}/..%2f..%2fetc%2fpasswd`);
      expect([403, 404]).toContain(escape.status);
    } finally {
      await runner.dispose();
    }

    await expect(fetch(`http://127.0.0.1:${prep.metroPort}/metadata.json`)).rejects.toThrow();
  }, 30_000);

  it('fails loudly when expo export exits non-zero', async () => {
    const { dir } = await worktree(FAKE_METRO);
    const exporter = path.join(dir, 'fail-export.cjs');
    await fs.writeFile(exporter, `process.stderr.write('Metro failed to bundle\\n'); process.exit(1);`);
    const runner = new ExpoCandidateRunner({
      projectRoot: dir,
      mode: 'export',
      cacheDir: path.join(dir, '.cache'),
      install: false,
      portRange: { min: 42900, max: 42960 },
      expoCommand: { command: process.execPath, args: [exporter] },
    });
    await expect(runner.prepare(dir, 'l'.repeat(40))).rejects.toThrow(/Metro failed to bundle/);
    await runner.dispose();
  }, 30_000);
});
