/**
 * The primary integration test: a full 64-commit bisect, offline, no cloud.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, latestRunDir, makeRepo, readEvents, runCli } from './helpers.js';

const CULPRIT_INDEX = 41;

describe('expo-bisect run --dry-run', () => {
  it(
    'searches 64 commits end to end and names the culprit',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 64, culpritIndex: CULPRIT_INDEX });
      const culprit = shas[CULPRIT_INDEX]!;

      const result = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--flow',
          'flows/checkout.yaml',
          '--expect',
          'the order confirmation screen appears',
          '--dry-run',
          '--culprit',
          culprit,
          '--no-ui',
          '--port',
          '0',
        ],
        { cwd: dir },
      );

      // stderr may carry notices from the report renderer; it must carry no failure
      expect(result.stderr).not.toContain('✖');
      expect(result.code).toBe(0);

      const runDir = await latestRunDir(dir);
      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      expect(types[0]).toBe('search.started');
      expect(types.filter((t) => t === 'round.started')).toHaveLength(6); // ceil(log2(64))
      expect(types.filter((t) => t === 'commit.completed')).toHaveLength(6);
      expect(types.filter((t) => t === 'range.narrowed')).toHaveLength(6);
      expect(types).toContain('culprit.found');
      expect(types.at(-1)).toBe('report.ready');

      const started = events[0] as { meta: Record<string, unknown> };
      expect(started.meta).toMatchObject({ totalCommits: 64, plannedRounds: 6 });

      const found = events.find((e) => e.type === 'culprit.found') as {
        goodSha: string;
        badSha: string;
        diagnosis?: string;
      };
      expect(found.badSha).toBe(culprit);
      expect(found.goodSha).toBe(shas[CULPRIT_INDEX - 1]);
      expect(found.diagnosis).toBeTruthy();

      // every flow.step names a real step of the flow
      const steps = events.filter((e) => e.type === 'flow.step') as { total: number }[];
      expect(steps).toHaveLength(6 * 7);
      expect(new Set(steps.map((s) => s.total))).toEqual(new Set([7]));

      const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as {
        finishedAt?: string;
        culprit?: { badSha: string; diagnosis?: string };
        results: Record<string, unknown>;
      };
      expect(state.finishedAt).toBeTruthy();
      expect(state.culprit?.badSha).toBe(culprit);
      expect(Object.keys(state.results)).toHaveLength(6);

      const report = await stat(path.join(runDir, 'report.html'));
      expect(report.size).toBeGreaterThan(1000);

      // the repo is exactly as we found it
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      expect((await git(dir, ['worktree', 'list'])).split('\n')).toHaveLength(1);
    },
    180_000,
  );

  it(
    'writes nothing key-shaped into the run directory',
    async () => {
      const secret = 'rvl_live_3f9a2c7b41de6058aa17bc9204ef3d5162';
      const { dir, shas } = await makeRepo({ commits: 10, culpritIndex: 6 });

      const result = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--dry-run',
          '--culprit',
          shas[6]!,
          // a credential smuggled in through free text the runner echoes back
          '--expect',
          `the confirmation appears when authorized with ${secret}`,
          '--no-ui',
          '--port',
          '0',
        ],
        { cwd: dir, env: { REVYL_API_KEY: secret, EXPO_TOKEN: 'expo_tok_abcdef1234567890' } },
      );

      expect(result.code).toBe(0);

      const runDir = await latestRunDir(dir);
      for (const file of ['events.jsonl', 'state.json', 'run.json', 'report.html']) {
        const contents = await readFile(path.join(runDir, file), 'utf8');
        expect(contents, `${file} leaked the api key`).not.toContain(secret);
        expect(contents, `${file} leaked the expo token`).not.toContain(
          'expo_tok_abcdef1234567890',
        );
        expect(contents).not.toContain('rvl_live_');
      }
      // it did redact rather than simply drop the text
      const events = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
      expect(events).toContain('[redacted]');
      expect(events).toContain('the confirmation appears when authorized with');
    },
    120_000,
  );

  it(
    'retries an inconclusive candidate exactly once',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 16, culpritIndex: 10 });
      // index 7 is the first midpoint, so it is certain to be tested
      const flakySha = shas[7]!;

      const result = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--dry-run',
          '--culprit',
          shas[10]!,
          '--flaky',
          flakySha,
          '--no-ui',
          '--port',
          '0',
        ],
        { cwd: dir },
      );

      expect(result.code).toBe(0);
      const events = await readEvents(await latestRunDir(dir));
      const flaky = events
        .filter((e) => e.type === 'commit.completed')
        .map((e) => (e as { result: { sha: string; state: string; attempt: number } }).result)
        .filter((r) => r.sha === flakySha);

      // the failed attempt is persisted, and the retry resolves it
      expect(flaky).toHaveLength(2);
      expect(flaky[0]!.state).toBe('inconclusive');
      expect(flaky[1]!.attempt).toBe(2);
      expect(['good', 'bad', 'skipped']).toContain(flaky[1]!.state);
      expect(result.stdout).toContain('inconclusive — retrying once');

      const found = events.find((e) => e.type === 'culprit.found') as { badSha: string };
      expect(found.badSha).toBe(shas[10]);
    },
    120_000,
  );

  it(
    'guards against a range that is too wide to be worth searching',
    async () => {
      const { dir } = await makeRepo({ commits: 12, culpritIndex: 7 });
      const result = await runCli(
        ['run', '--good', 'v1.0', '--bad', 'HEAD', '--dry-run', '--max-candidates', '8'],
        { cwd: dir },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('more than the 8-commit guard');
      expect(result.stderr).toContain('--max-candidates 12');
    },
    120_000,
  );

  it(
    'evaluates candidates in parallel with --concurrency and still finds the culprit',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 32, culpritIndex: 20 });
      const result = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--dry-run',
          '--culprit',
          shas[20]!,
          '--concurrency',
          '4',
          '--no-ui',
          '--port',
          '0',
        ],
        { cwd: dir },
      );

      expect(result.code).toBe(0);
      const events = await readEvents(await latestRunDir(dir));
      const found = events.find((e) => e.type === 'culprit.found') as { badSha: string };
      expect(found.badSha).toBe(shas[20]);

      // more commits were put on a device than a serial search would have needed
      const ran = new Set(
        events.filter((e) => e.type === 'commit.running').map((e) => (e as { sha: string }).sha),
      );
      expect(ran.size).toBeGreaterThan(5);
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      expect((await git(dir, ['worktree', 'list'])).split('\n')).toHaveLength(1);
    },
    180_000,
  );
});
