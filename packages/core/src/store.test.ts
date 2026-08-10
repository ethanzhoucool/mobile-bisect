import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Bisector } from './bisect.js';
import { FakeRunner } from './fake-runner.js';
import { RunStore } from './store.js';
import { drive, makeCommits, makeFlow, makeMeta, pick, recorder } from './test-helpers.js';
import type { BisectEvent, BisectState } from './types.js';

const tmpdirs: string[] = [];

async function sandbox(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-store-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const evt = (n: number): BisectEvent => ({
  type: 'flow.step',
  at: new Date(1700000000000 + n).toISOString(),
  sha: 'abc',
  index: n,
  total: 10,
  label: `step ${n}`,
});

describe('RunStore', () => {
  it('lays out .mobile-bisect/runs/<id>/{events.jsonl,artifacts}', async () => {
    const cwd = await sandbox();
    const store = await RunStore.create(cwd, 'run-1');
    expect(store.dir).toBe(path.join(cwd, '.mobile-bisect', 'runs', 'run-1'));
    expect(store.artifactsDir).toBe(path.join(store.dir, 'artifacts'));
    expect(store.runId).toBe('run-1');
    await expect(fs.stat(store.artifactsDir)).resolves.toBeTruthy();
    await expect(store.readEvents()).resolves.toEqual([]);
    await expect(store.loadState()).resolves.toBeNull();
  });

  it('appends events in order, even when the calls are not awaited in order', async () => {
    const cwd = await sandbox();
    const store = await RunStore.create(cwd, 'run-1');
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(evt(i))));
    const events = await store.readEvents();
    expect(events).toHaveLength(50);
    expect(events.map((e) => (e as { index: number }).index)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    const raw = await fs.readFile(store.eventsPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter(Boolean)).toHaveLength(50);
  });

  it('tolerates a torn final line but not corruption mid-file', async () => {
    const cwd = await sandbox();
    const store = await RunStore.create(cwd, 'run-1');
    await store.append(evt(1));
    await fs.appendFile(store.eventsPath, '{"type":"flow.st', 'utf8');
    await expect(store.readEvents()).resolves.toHaveLength(1);

    await fs.appendFile(store.eventsPath, '\n' + JSON.stringify(evt(2)) + '\n', 'utf8');
    await expect(store.readEvents()).rejects.toThrow(/not valid JSON/);
  });

  it('writes state.json atomically and leaves no temp files behind', async () => {
    const cwd = await sandbox();
    const store = await RunStore.create(cwd, 'run-1');
    const commits = makeCommits(8);
    const { emit } = recorder();
    const state = new Bisector({ commits, meta: makeMeta(8), emit }).state;

    await store.saveState(state);
    const loaded = await store.loadState();
    expect(loaded).toEqual(JSON.parse(JSON.stringify(state)) as BisectState);

    const entries = await fs.readdir(store.dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    expect(entries.sort()).toEqual(['artifacts', 'events.jsonl', 'state.json']);
  });

  it('lists and reopens runs, and finds the latest', async () => {
    const cwd = await sandbox();
    await RunStore.create(cwd, 'run-a');
    await new Promise((r) => setTimeout(r, 10));
    const b = await RunStore.create(cwd, 'run-b');
    await b.append(evt(1));

    expect(await RunStore.list(cwd)).toEqual(['run-a', 'run-b']);
    expect((await RunStore.latest(cwd))?.runId).toBe('run-b');
    expect((await RunStore.open(cwd, 'run-a')).runId).toBe('run-a');
    await expect(RunStore.open(cwd, 'nope')).rejects.toThrow(/not found/);
  });

  it('returns empty/null on a directory with no runs', async () => {
    const cwd = await sandbox();
    expect(await RunStore.list(cwd)).toEqual([]);
    expect(await RunStore.latest(cwd)).toBeNull();
  });

  it('refuses run ids that would escape the runs directory', async () => {
    const cwd = await sandbox();
    await expect(RunStore.create(cwd, '../evil')).rejects.toThrow(/path separators/);
    await expect(RunStore.create(cwd, '..')).rejects.toThrow(/invalid run id/);
  });

  it('redacts credential-shaped strings before they reach disk', async () => {
    const cwd = await sandbox();
    const store = await RunStore.create(cwd, 'run-1');
    await store.append({
      type: 'search.failed',
      at: new Date().toISOString(),
      message:
        'git failed: REVYL_API_KEY=notarealkey_0123456789abcdefghij authorization: Bearer abcdef0123456789 ?api_key=hunter2hunter2',
    });
    const raw = await fs.readFile(store.eventsPath, 'utf8');
    expect(raw).not.toMatch(/notarealkey_0123456789abcdefghij/);
    expect(raw).not.toMatch(/hunter2hunter2/);
    expect(raw).not.toMatch(/abcdef0123456789/);
    expect(raw).toMatch(/\[redacted\]/);
  });
});

describe('resume', () => {
  const FLOW = makeFlow(['Launch', 'Tap buy', 'Assert receipt']);
  const N = 64;
  const CULPRIT = 41;

  async function halfRun(cwd: string) {
    const commits = makeCommits(N);
    const store = await RunStore.create(cwd, 'resumable');
    const events: BisectEvent[] = [];
    const emit = (e: BisectEvent) => {
      events.push(e);
      void store.append(e);
    };
    const bisector = new Bisector({ commits, meta: makeMeta(N), emit });
    const runner = new FakeRunner({ culpritSha: commits[CULPRIT]!.sha, commits });
    await drive({
      bisector,
      runner,
      flow: FLOW,
      assertion: 'the receipt appears',
      maxRounds: 3,
      afterRound: () => store.saveState(bisector.state),
    });
    await store.append({ type: 'report.ready', at: new Date().toISOString(), reportPath: 'x' });
    return { store, commits, events, bisector };
  }

  it('picks up on the right round and range, and lands on the same culprit', async () => {
    const cwd = await sandbox();
    const { commits, bisector: first } = await halfRun(cwd);
    expect(first.state.round).toBe(3);
    expect(first.state.activeRange).toEqual([40, 46]);

    // Fresh process: reopen the run and rebuild from state.json alone.
    const reopened = await RunStore.open(cwd, 'resumable');
    const state = (await reopened.loadState())!;
    expect(state.round).toBe(3);

    const events: BisectEvent[] = [];
    const resumed = Bisector.resume(state, (e) => void events.push(e));
    expect(resumed.state.activeRange).toEqual([40, 46]);
    expect(resumed.state.round).toBe(3);
    expect(events).toHaveLength(0); // replay is silent; the old events are already on disk

    const runner = new FakeRunner({ culpritSha: commits[CULPRIT]!.sha, commits });
    await drive({ bisector: resumed, runner, flow: FLOW, assertion: 'the receipt appears' });

    expect(resumed.culprit).toEqual({
      goodSha: commits[CULPRIT - 1]!.sha,
      badSha: commits[CULPRIT]!.sha,
    });
    expect(pick(events, 'round.started').map((e) => e.round)).toEqual([4, 5, 6]);
    expect(resumed.state.round).toBe(6);
  });

  it('re-offers the same candidate when the crash landed mid-round', async () => {
    const cwd = await sandbox();
    const commits = makeCommits(N);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(N), emit });
    b.nextCandidate();
    const pending = b.nextCandidate()!; // same candidate, no verdict yet
    b.markRunning(pending.sha);

    const events: BisectEvent[] = [];
    const resumed = Bisector.resume(b.state, (e) => void events.push(e));
    expect(resumed.nextCandidate()!.sha).toBe(pending.sha);
    expect(resumed.state.round).toBe(1);
  });

  it('resumes a completed run as complete', () => {
    const commits = makeCommits(16);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    for (;;) {
      const c = b.nextCandidate();
      if (!c) break;
      b.record({ sha: c.sha, subject: c.subject, author: c.author, state: c.index >= 9 ? 'bad' : 'good' });
    }
    const events: BisectEvent[] = [];
    const resumed = Bisector.resume(b.state, (e) => void events.push(e));
    expect(resumed.isComplete).toBe(true);
    expect(resumed.culprit).toEqual(b.culprit);
    expect(resumed.nextCandidate()).toBeNull();
  });

  it('preserves skips across a resume', () => {
    const commits = makeCommits(16);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    const first = b.nextCandidate()!;
    b.record({ sha: first.sha, subject: first.subject, author: first.author, state: 'skipped' });

    const resumed = Bisector.resume(b.state, () => undefined);
    expect(resumed.nextCandidate()!.index).toBe(6);
    expect(resumed.state.round).toBe(2);
  });
});
