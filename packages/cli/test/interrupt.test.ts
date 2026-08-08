/**
 * Ctrl-C has to leave the repo, the devices and the run directory in a state
 * you can walk away from — and then walk back into with `resume`.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, latestRunDir, makeRepo, readEvents, runCli } from './helpers.js';

describe('interrupting a run', () => {
  it(
    'stops cleanly on Ctrl-C and resumes without re-running classified commits',
    async () => {
      const { dir, shas } = await makeRepo({ commits: 32, culpritIndex: 20 });

      let interrupted = false;
      const first = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--dry-run',
          '--culprit',
          shas[20]!,
          '--step-delay',
          '400',
          '--no-ui',
          '--port',
          '0',
        ],
        {
          cwd: dir,
          // interrupt in the middle of the second candidate's flow
          onStdout: (chunk, child) => {
            if (!interrupted && /narrow/.test(chunk)) {
              interrupted = true;
              setTimeout(() => child.kill('SIGINT'), 300);
            }
          },
          timeoutMs: 90_000,
        },
      );

      expect(interrupted).toBe(true);
      expect(first.code).toBe(130);
      expect(first.stdout).toContain('interrupted');
      expect(first.stdout).toMatch(/Resume where you left off/);
      expect(first.stdout).toMatch(/expo-bisect resume \S+/);

      // nothing of ours is left behind
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      expect((await git(dir, ['worktree', 'list'])).split('\n')).toHaveLength(1);

      const runDir = await latestRunDir(dir);
      await access(path.join(runDir, 'state.json'));
      const before = await readEvents(runDir);
      const classifiedBefore = before
        .filter((e) => e.type === 'commit.completed')
        .map((e) => (e as { result: { sha: string } }).result.sha);
      expect(classifiedBefore.length).toBeGreaterThan(0);

      const second = await runCli(['resume', '--no-ui', '--port', '0'], {
        cwd: dir,
        timeoutMs: 90_000,
      });

      expect(second.code).toBe(0);
      expect(second.stdout).toContain('commits already classified');

      const after = await readEvents(runDir);
      const found = after.find((e) => e.type === 'culprit.found') as { badSha: string };
      expect(found.badSha).toBe(shas[20]);

      // the commits classified before the interrupt were not run a second time
      const runsPerSha = new Map<string, number>();
      for (const event of after) {
        if (event.type !== 'commit.running') continue;
        const sha = (event as { sha: string }).sha;
        runsPerSha.set(sha, (runsPerSha.get(sha) ?? 0) + 1);
      }
      for (const sha of classifiedBefore) {
        expect(runsPerSha.get(sha) ?? 0).toBe(1);
      }
    },
    180_000,
  );
});
