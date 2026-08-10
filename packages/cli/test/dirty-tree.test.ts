/**
 * The promise that matters most: mobile-bisect never touches uncommitted work.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, makeRepo, runCli, tempDir } from './helpers.js';

const DIRTY = 'export const version = 999; // half-finished edit\n';

describe('dirty working tree', () => {
  it('refuses to start, and leaves the edit exactly as it was', async () => {
    const { dir } = await makeRepo({ commits: 6, culpritIndex: 4 });
    const file = path.join(dir, 'app', 'index.ts');
    await writeFile(file, DIRTY);

    const result = await runCli(
      ['run', '--good', 'v1.0', '--bad', 'HEAD', '--dry-run', '--no-ui', '--port', '0'],
      { cwd: dir },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('uncommitted changes');
    expect(result.stderr).toContain('--allow-dirty');
    expect(result.stderr).toContain('never modifies or discards uncommitted work');

    expect(await readFile(file, 'utf8')).toBe(DIRTY);
    expect(await git(dir, ['status', '--porcelain'])).toContain('app/index.ts');
  });

  it('proceeds with --allow-dirty and still does not touch the edit', async () => {
    const { dir } = await makeRepo({ commits: 8, culpritIndex: 5 });
    const file = path.join(dir, 'app', 'index.ts');
    await writeFile(file, DIRTY);

    const result = await runCli(
      [
        'run',
        '--good',
        'v1.0',
        '--bad',
        'HEAD',
        '--dry-run',
        '--allow-dirty',
        '--no-ui',
        '--port',
        '0',
      ],
      { cwd: dir },
    );

    expect(result.code).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(DIRTY);
    // Only the user's own edit is dirty — our runs and worktrees are ignored.
    const status = await git(dir, ['status', '--porcelain']);
    expect(status.split('\n')).toHaveLength(1);
    expect(status).toContain('M app/index.ts');
  });

  it('says so plainly when it is not a git repository', async () => {
    const dir = await tempDir();
    const result = await runCli(['run', '--good', 'a', '--bad', 'b', '--dry-run'], { cwd: dir });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('is not a git repository');
  });
});
