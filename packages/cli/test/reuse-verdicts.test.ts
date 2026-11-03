/**
 * `--reuse-verdicts`: every good/bad an earlier run of the same flow already
 * paid for is taken instead of run again. Device runs are counted by
 * `commit.running`, which is emitted once per candidate put on a device.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestRunDir, makeRepo, readEvents, runCli } from './helpers.js';

async function search(dir: string, extra: string[]) {
  const result = await runCli(
    ['run', '--good', 'v1.0', '--bad', 'HEAD', '--dry-run', '--no-ui', '--port', '0', ...extra],
    { cwd: dir },
  );
  expect(result.code, result.stderr).toBe(0);
  const runDir = await latestRunDir(dir);
  const events = await readEvents(runDir);
  const deviceRuns = events.filter((e) => e.type === 'commit.running').length;
  const found = events.find((e) => e.type === 'culprit.found') as { goodSha: string; badSha: string };
  return { result, runDir, events, deviceRuns, found };
}

async function onlyRunDir(dir: string): Promise<string> {
  const runs = path.join(dir, '.mobile-bisect', 'runs');
  const [id, ...rest] = await readdir(runs);
  expect(rest).toHaveLength(0);
  return path.join(runs, id!);
}

describe('mobile-bisect run --reuse-verdicts', () => {
  it(
    'answers a repeated search without a single device run',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 32, culpritIndex: 20 });
      const culprit = ['--culprit', shas[20]!];

      const first = await search(dir, culprit);
      expect(first.deviceRuns).toBe(5);
      expect(first.found.badSha).toBe(shas[20]);

      const again = await search(dir, [...culprit, '--reuse-verdicts']);
      expect(again.deviceRuns).toBe(0);
      expect(again.found).toMatchObject({ goodSha: first.found.goodSha, badSha: first.found.badSha });
      expect(again.result.stdout).toContain('narrowed 31 commits to 1, with nothing run');
      const started = again.events[0] as { meta: { totalCommits: number } };
      expect(started.meta.totalCommits).toBe(2);
    },
    180_000,
  );

  it(
    'only pays for the rounds an earlier run did not get to',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 32, culpritIndex: 20 });
      const culprit = ['--culprit', shas[20]!];
      await search(dir, culprit);

      // Keep only the first round's verdict, as if that run had stopped there.
      const statePath = path.join(await onlyRunDir(dir), 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        results: Record<string, { state: string }>;
      };
      expect(state.results[shas[15]!]?.state).toBe('good');
      state.results = { [shas[15]!]: state.results[shas[15]!]! };
      await writeFile(statePath, JSON.stringify(state));

      const resumedFresh = await search(dir, [...culprit, '--reuse-verdicts']);
      expect(resumedFresh.result.stdout).toContain('narrowed 31 commits to 16, with nothing run');
      expect(resumedFresh.deviceRuns).toBe(4); // one fewer than the 5 a cold search takes
      expect(resumedFresh.found.badSha).toBe(shas[20]);
    },
    180_000,
  );

  it(
    'reuses nothing from a run that checked a different assertion',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 16, culpritIndex: 9 });
      const culprit = ['--culprit', shas[9]!];
      await search(dir, [...culprit, '--expect', 'the cart shows one item']);

      const other = await search(dir, [...culprit, '--expect', 'the order confirmation screen appears', '--reuse-verdicts']);
      expect(other.result.stdout).toContain('no earlier run used this flow');
      expect(other.deviceRuns).toBe(4);
    },
    180_000,
  );

  it(
    'leaves a plain run alone',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 16, culpritIndex: 9 });
      const culprit = ['--culprit', shas[9]!];
      const first = await search(dir, culprit);
      const second = await search(dir, culprit);
      expect(second.deviceRuns).toBe(first.deviceRuns);
      expect(second.result.stdout).not.toContain('reuse');
    },
    180_000,
  );
});
