import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCleanWorktree,
  cleanupAllWorktrees,
  commitMeta,
  createWorktree,
  isGitRepo,
  listCandidates,
  redactSecrets,
  resolveRef,
  showDiff,
  WORKTREE_ROOT,
} from './index.js';

const exec = promisify(execFile);
const tmpdirs: string[] = [];

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir });
  return stdout;
}

/** A repo with `n` linear commits touching app/checkout.tsx, oldest first. */
async function makeRepo(n = 8): Promise<{ dir: string; shas: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-git-'));
  tmpdirs.push(dir);
  await git(dir, ['init', '--quiet']);
  await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test Author']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.mkdir(path.join(dir, 'app'), { recursive: true });

  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    await fs.writeFile(path.join(dir, 'app', 'checkout.tsx'), `export const build = ${i};\n`, 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', `commit ${i}`]);
    shas.push((await git(dir, ['rev-parse', 'HEAD'])).trim());
  }
  await git(dir, ['tag', 'v1.0.0', shas[0]!]);
  return { dir, shas };
}

afterEach(async () => {
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('isGitRepo / resolveRef / commitMeta', () => {
  it('detects a repo and a non-repo', async () => {
    const { dir } = await makeRepo(2);
    expect(await isGitRepo(dir)).toBe(true);
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-bisect-plain-'));
    tmpdirs.push(plain);
    expect(await isGitRepo(plain)).toBe(false);
  });

  it('resolves HEAD, tags, short shas and revisions', async () => {
    const { dir, shas } = await makeRepo(4);
    expect(await resolveRef(dir, 'HEAD')).toBe(shas[3]);
    expect(await resolveRef(dir, 'v1.0.0')).toBe(shas[0]);
    expect(await resolveRef(dir, shas[2]!.slice(0, 7))).toBe(shas[2]);
    expect(await resolveRef(dir, 'HEAD~2')).toBe(shas[1]);
  });

  it('refuses unresolvable and option-shaped refs', async () => {
    const { dir } = await makeRepo(2);
    await expect(resolveRef(dir, 'no-such-ref')).rejects.toThrow(/cannot resolve/);
    await expect(resolveRef(dir, '--upload-pack=touch /tmp/pwned')).rejects.toThrow(/looks like an option/);
    // execFile means metacharacters are inert rather than executed.
    await expect(resolveRef(dir, 'HEAD; rm -rf /')).rejects.toThrow(/cannot resolve/);
  });

  it('reads a commit summary', async () => {
    const { dir, shas } = await makeRepo(3);
    const meta = await commitMeta(dir, shas[1]!);
    expect(meta).toMatchObject({ sha: shas[1], subject: 'commit 1', author: 'Test Author', index: 0 });
    expect(meta.shortSha).toBe(shas[1]!.slice(0, meta.shortSha.length));
    expect(Date.parse(meta.authoredAt)).not.toBeNaN();
  });
});

describe('listCandidates', () => {
  it('returns both boundaries, oldest-first, reindexed from 0', async () => {
    const { dir, shas } = await makeRepo(8);
    const commits = await listCandidates(dir, shas[0]!, 'HEAD');
    expect(commits).toHaveLength(8);
    expect(commits.map((c) => c.sha)).toEqual(shas);
    expect(commits.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(commits[0]!.subject).toBe('commit 0');
    expect(commits[7]!.subject).toBe('commit 7');
    expect(commits.every((c) => c.shortSha.length >= 7 && c.sha.startsWith(c.shortSha))).toBe(true);
  });

  it('accepts symbolic refs on both ends', async () => {
    const { dir, shas } = await makeRepo(5);
    const commits = await listCandidates(dir, 'v1.0.0', 'main');
    expect(commits.map((c) => c.sha)).toEqual(shas);
  });

  it('rejects a good ref that is not an ancestor of bad', async () => {
    const { dir, shas } = await makeRepo(4);
    await git(dir, ['checkout', '--quiet', '-b', 'side', shas[1]!]);
    await fs.writeFile(path.join(dir, 'side.txt'), 'side\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'side commit']);
    const side = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await git(dir, ['checkout', '--quiet', 'main']);

    await expect(listCandidates(dir, side, 'main')).rejects.toThrow(/not an ancestor/);
  });

  it('rejects identical boundaries', async () => {
    const { dir } = await makeRepo(3);
    await expect(listCandidates(dir, 'HEAD', 'HEAD')).rejects.toThrow(/nothing to bisect/);
  });

  it('handles the minimum two-commit range', async () => {
    const { dir, shas } = await makeRepo(2);
    const commits = await listCandidates(dir, shas[0]!, shas[1]!);
    expect(commits.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe('assertCleanWorktree', () => {
  it('passes on a clean tree and ignores untracked files', async () => {
    const { dir } = await makeRepo(2);
    await expect(assertCleanWorktree(dir)).resolves.toBeUndefined();
    await fs.writeFile(path.join(dir, 'scratch.txt'), 'not tracked\n', 'utf8');
    await expect(assertCleanWorktree(dir)).resolves.toBeUndefined();
  });

  it('throws and names the dirty paths', async () => {
    const { dir } = await makeRepo(2);
    await fs.writeFile(path.join(dir, 'app', 'checkout.tsx'), 'edited\n', 'utf8');
    await expect(assertCleanWorktree(dir)).rejects.toThrow(/app\/checkout\.tsx/);
    await expect(assertCleanWorktree(dir)).rejects.toThrow(/will not touch your working tree/);
  });
});

describe('worktrees', () => {
  it('checks a commit out in a detached worktree under .mobile-bisect/worktrees', async () => {
    const { dir, shas } = await makeRepo(6);
    const wt = await createWorktree(dir, shas[2]!);
    expect(wt.path).toBe(path.join(dir, WORKTREE_ROOT, shas[2]!));
    expect(wt.sha).toBe(shas[2]);
    const content = await fs.readFile(path.join(wt.path, 'app', 'checkout.tsx'), 'utf8');
    expect(content).toBe('export const build = 2;\n');
    expect((await git(wt.path, ['rev-parse', 'HEAD'])).trim()).toBe(shas[2]);
    expect((await git(wt.path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached'))).toBe(
      'detached',
    );

    await wt.cleanup();
    await expect(fs.stat(wt.path)).rejects.toThrow();
  });

  it('is idempotent when the same sha is checked out twice', async () => {
    const { dir, shas } = await makeRepo(4);
    const a = await createWorktree(dir, shas[1]!);
    const b = await createWorktree(dir, shas[1]!);
    expect(b.path).toBe(a.path);
    await b.cleanup();
    await a.cleanup();
  });

  it('registers and unregisters crash handlers around live worktrees', async () => {
    const { dir, shas } = await makeRepo(3);
    const before = process.listenerCount('SIGINT');
    const wt = await createWorktree(dir, shas[1]!);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    await wt.cleanup();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('cleanupAllWorktrees removes every worktree and the root directory', async () => {
    const { dir, shas } = await makeRepo(6);
    await createWorktree(dir, shas[1]!);
    await createWorktree(dir, shas[3]!);
    expect((await git(dir, ['worktree', 'list'])).trim().split('\n')).toHaveLength(3);

    await cleanupAllWorktrees(dir);
    expect((await git(dir, ['worktree', 'list'])).trim().split('\n')).toHaveLength(1);
    await expect(fs.stat(path.join(dir, WORKTREE_ROOT))).rejects.toThrow();
  });
});

describe('SIGINT cleanup', () => {
  // Exercises the real signal path in a child process. Needs the built entry,
  // which `npm test` produces; a bare `vitest run` skips it.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  const built = existsSync(dist);

  it.skipIf(!built)('removes live worktrees when the process is interrupted', async () => {
    const { dir, shas } = await makeRepo(3);
    const script = path.join(dir, 'child.mjs');
    await fs.writeFile(
      script,
      [
        `import { createWorktree } from ${JSON.stringify(pathToFileURL(dist).href)};`,
        `await createWorktree(process.argv[2], process.argv[3]);`,
        `setImmediate(() => process.kill(process.pid, 'SIGINT'));`,
        `setTimeout(() => process.exit(1), 10000);`,
      ].join('\n'),
      'utf8',
    );

    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [script, dir, shas[1]!], { stdio: 'ignore' });
      child.on('exit', (c) => resolve(c));
    });

    expect(code).toBe(130);
    await expect(fs.stat(path.join(dir, WORKTREE_ROOT, shas[1]!))).rejects.toThrow();
    expect((await git(dir, ['worktree', 'list'])).trim().split('\n')).toHaveLength(1);
  }, 20_000);
});

describe('showDiff', () => {
  it('returns the patch for a single commit', async () => {
    const { dir, shas } = await makeRepo(4);
    const diff = await showDiff(dir, shas[2]!);
    expect(diff).toContain('diff --git a/app/checkout.tsx b/app/checkout.tsx');
    expect(diff).toContain('-export const build = 1;');
    expect(diff).toContain('+export const build = 2;');
    expect(diff).toContain('commit 2');
  });

  it('narrows to the requested paths', async () => {
    const { dir } = await makeRepo(2);
    await fs.writeFile(path.join(dir, 'README.md'), '# hi\n', 'utf8');
    await fs.writeFile(path.join(dir, 'app', 'checkout.tsx'), 'export const build = 99;\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'touch two files']);

    const all = await showDiff(dir, 'HEAD');
    expect(all).toContain('README.md');
    const narrowed = await showDiff(dir, 'HEAD', { paths: ['app'] });
    expect(narrowed).not.toContain('README.md');
    expect(narrowed).toContain('app/checkout.tsx');
  });
});

describe('SAFETY: the user working tree is never mutated', () => {
  it('survives a full bisect-shaped run with uncommitted changes present', async () => {
    const { dir, shas } = await makeRepo(8);

    // Dirty state a user would be furious to lose.
    const dirtyPath = path.join(dir, 'app', 'checkout.tsx');
    const dirty = 'export const build = 7;\n// WIP: do not lose me\n';
    await fs.writeFile(dirtyPath, dirty, 'utf8');
    const untrackedPath = path.join(dir, 'notes.md');
    await fs.writeFile(untrackedPath, 'scratch notes\n', 'utf8');
    await git(dir, ['add', 'app/checkout.tsx']); // staged, not committed

    const headBefore = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const branchBefore = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const statusBefore = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
    const reflogBefore = (await git(dir, ['reflog', '--format=%H %gs'])).trim();

    // Everything a bisect round does, for several candidates.
    const commits = await listCandidates(dir, shas[0]!, 'HEAD');
    expect(commits).toHaveLength(8);
    for (const index of [4, 2, 3]) {
      const wt = await createWorktree(dir, commits[index]!.sha);
      const built = await fs.readFile(path.join(wt.path, 'app', 'checkout.tsx'), 'utf8');
      expect(built).toBe(`export const build = ${index};\n`);
      await showDiff(dir, commits[index]!.sha);
      await wt.cleanup();
    }
    await cleanupAllWorktrees(dir);

    expect(await fs.readFile(dirtyPath, 'utf8')).toBe(dirty);
    expect(await fs.readFile(untrackedPath, 'utf8')).toBe('scratch notes\n');
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branchBefore);
    expect(await git(dir, ['status', '--porcelain', '--untracked-files=no'])).toBe(statusBefore);
    expect((await git(dir, ['reflog', '--format=%H %gs'])).trim()).toBe(reflogBefore);
    // The staged edit is still staged, byte for byte.
    expect(await git(dir, ['show', ':app/checkout.tsx'])).toBe(dirty);
    // And no bisect session was ever started in the user's repo.
    await expect(fs.stat(path.join(dir, '.git', 'BISECT_START'))).rejects.toThrow();
  });
});

describe('redactSecrets', () => {
  it('scrubs credential-shaped strings without wrecking signed urls', () => {
    expect(redactSecrets('REVYL_API_KEY=notarealkey_0123456789abcdefghij')).toBe(
      'REVYL_API_KEY=[redacted]',
    );
    expect(redactSecrets('https://x.dev/a?token=abcdef123456&page=2')).toBe(
      'https://x.dev/a?token=[redacted]&page=2',
    );
    expect(redactSecrets('https://user:hunter2@github.com/o/r.git')).toBe(
      'https://user:[redacted]@github.com/o/r.git',
    );
    const signed = 'https://artifacts.revyl.ai/x/run.mp4?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=900';
    expect(redactSecrets(signed)).toBe(signed);
  });

  it('keeps secrets out of git error messages', async () => {
    const { dir } = await makeRepo(2);
    await expect(resolveRef(dir, 'refs/heads/nope?access_token=supersecretvalue')).rejects.toThrow(
      /\[redacted\]/,
    );
  });
});
