/**
 * Git access for mobile-bisect.
 *
 * SAFETY CONTRACT: this package never mutates the user's working tree. No
 * checkout, reset, stash, clean, or `git bisect` is ever issued against it —
 * every candidate is materialized in a detached worktree under
 * `.mobile-bisect/worktrees/<sha>`, which is registered for cleanup on exit and
 * on SIGINT/SIGTERM. All git invocations go through `execFile`, so a ref
 * containing shell metacharacters is inert.
 */

import { execFile, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Type-only: erased at compile time, so this package ships zero runtime deps.
import type { CommitSummary } from '@mobile-bisect/core';

export const WORKTREE_ROOT = path.join('.mobile-bisect', 'worktrees');

/** `%H \x1f %h \x1f author \x1f authorDate \x1f subject` — subject is always last. */
const FMT = '%H%x1f%h%x1f%an%x1f%aI%x1f%s';
const US = '\x1f';

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, args: string[], exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    const out = await git(repo, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Peel any ref/rev to a full commit sha. Throws if it does not resolve. */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  assertRefish(ref);
  try {
    const out = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = out.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected rev-parse output for "${ref}"`);
    return sha;
  } catch (err) {
    throw new Error(`cannot resolve "${ref}" to a commit in ${repo}: ${describe(err)}`);
  }
}

/**
 * Oldest-first commit list from `good` to `bad`, INCLUDING both boundaries.
 * Index 0 is the known-good boundary, the last entry the known-bad one — which
 * is exactly the shape `Bisector` expects.
 */
export async function listCandidates(
  repo: string,
  goodRef: string,
  badRef: string,
): Promise<CommitSummary[]> {
  const good = await resolveRef(repo, goodRef);
  const bad = await resolveRef(repo, badRef);
  if (good === bad) {
    throw new Error(`--good and --bad both resolve to ${good.slice(0, 7)}; nothing to bisect`);
  }
  if (!(await isAncestor(repo, good, bad))) {
    throw new Error(
      `${goodRef} (${good.slice(0, 7)}) is not an ancestor of ${badRef} (${bad.slice(0, 7)}); ` +
        'bisect needs a linear ancestry between the two boundaries',
    );
  }

  const out = await git(repo, [
    'rev-list',
    '--ancestry-path',
    '--reverse',
    `--format=${FMT}`,
    `${good}..${bad}`,
  ]);

  const commits: CommitSummary[] = [await commitMeta(repo, good)];
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('commit ')) continue; // `--format` prints a header per commit
    commits.push(parseSummary(line));
  }
  if (commits[commits.length - 1]?.sha !== bad) {
    throw new Error(`rev-list did not reach ${badRef} (${bad.slice(0, 7)}) along the ancestry path`);
  }
  return commits.map((c, index) => ({ ...c, index }));
}

/** Throws if tracked files are modified. Untracked files are harmless and ignored. */
export async function assertCleanWorktree(repo: string): Promise<void> {
  const out = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (dirty.length === 0) return;
  const shown = dirty.slice(0, 10).map((l) => `  ${l}`).join('\n');
  const more = dirty.length > 10 ? `\n  …and ${dirty.length - 10} more` : '';
  throw new Error(
    `${repo} has uncommitted changes:\n${shown}${more}\n` +
      'Commit or stash them yourself first — mobile-bisect will not touch your working tree.',
  );
}

export interface Worktree {
  path: string;
  sha: string;
  cleanup(): Promise<void>;
}

/**
 * Materialize `sha` in a detached worktree. The user's HEAD, index, and
 * uncommitted changes are untouched.
 */
export async function createWorktree(repo: string, sha: string, root?: string): Promise<Worktree> {
  const repoAbs = path.resolve(repo);
  const rootAbs = root ? path.resolve(root) : path.join(repoAbs, WORKTREE_ROOT);
  const full = await resolveRef(repoAbs, sha);
  const dir = path.join(rootAbs, full);

  await fs.mkdir(rootAbs, { recursive: true });
  await removeWorktree(repoAbs, dir); // idempotent: reuse of a stale dir would fail `worktree add`

  try {
    await git(repoAbs, ['worktree', 'add', '--detach', '--force', dir, full]);
  } catch (err) {
    throw new Error(`failed to create worktree for ${full.slice(0, 7)}: ${describe(err)}`);
  }

  LIVE.set(dir, repoAbs);
  installHandlers();

  let cleaned = false;
  return {
    path: dir,
    sha: full,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      LIVE.delete(dir);
      await removeWorktree(repoAbs, dir);
      uninstallHandlersIfIdle();
    },
  };
}

/** Prune git's bookkeeping and delete everything under our worktree root. */
export async function cleanupAllWorktrees(repo: string): Promise<void> {
  const repoAbs = path.resolve(repo);
  const rootAbs = path.join(repoAbs, WORKTREE_ROOT);

  try {
    const listed = await git(repoAbs, ['worktree', 'list', '--porcelain']);
    for (const line of listed.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const wt = line.slice('worktree '.length).trim();
      if (isInside(rootAbs, wt)) await removeWorktree(repoAbs, wt);
    }
  } catch {
    /* a repo with no worktrees still needs the directory sweep below */
  }

  for (const [dir, r] of [...LIVE]) {
    if (r === repoAbs) {
      LIVE.delete(dir);
      await removeWorktree(repoAbs, dir);
    }
  }

  await fs.rm(rootAbs, { recursive: true, force: true });
  await git(repoAbs, ['worktree', 'prune']).catch(() => undefined);
  uninstallHandlersIfIdle();
}

/** Unified diff for a single commit, optionally narrowed to `paths`. */
export async function showDiff(
  repo: string,
  sha: string,
  opts?: { paths?: string[] },
): Promise<string> {
  const full = await resolveRef(repo, sha);
  const args = ['show', '--no-color', '--patch', '--format=%H %s%n', full];
  if (opts?.paths?.length) args.push('--', ...opts.paths);
  return git(repo, args);
}

/** One commit's metadata. `index` is 0; callers reindex against their own list. */
export async function commitMeta(repo: string, sha: string): Promise<CommitSummary> {
  const full = await resolveRef(repo, sha);
  const out = await git(repo, ['show', '--no-patch', `--format=${FMT}`, full]);
  const line = out.split('\n').find((l) => l.includes(US));
  if (!line) throw new Error(`could not read metadata for ${full.slice(0, 7)}`);
  return parseSummary(line);
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

function git(repo: string, args: string[]): Promise<string> {
  const full = ['--no-pager', '-c', 'color.ui=false', ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      full,
      {
        cwd: repo,
        maxBuffer: 64 * 1024 * 1024,
        // Never let git block on a credential prompt or an editor.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          reject(
            new GitError(
              `git ${redact(args.join(' '))} failed: ${redact(String(stderr || err.message)).trim()}`,
              args,
              typeof code === 'number' ? code : null,
              redact(String(stderr ?? '')),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function parseSummary(line: string): CommitSummary {
  const [sha, shortSha, author, authoredAt, ...rest] = line.split(US);
  if (!sha || !shortSha) throw new Error(`unparseable commit record: ${JSON.stringify(line)}`);
  return {
    sha,
    shortSha,
    subject: rest.join(US) ?? '',
    author: author ?? '',
    authoredAt: authoredAt ?? '',
    index: 0,
  };
}

/** A ref that starts with `-` would be read as an option; reject it outright. */
function assertRefish(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0) throw new Error('ref must be a non-empty string');
  if (ref.startsWith('-')) throw new Error(`refusing ref that looks like an option: "${ref}"`);
  if (/[\0\n]/.test(ref)) throw new Error('ref must not contain newlines or NUL');
}

function describe(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Crash-safe worktree cleanup
// ---------------------------------------------------------------------------

/** worktree dir -> repo it belongs to. */
const LIVE = new Map<string, string>();
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let handlersInstalled = false;

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', cleanupSync);
  for (const sig of SIGNALS) process.on(sig, onSignal);
}

function uninstallHandlersIfIdle(): void {
  if (!handlersInstalled || LIVE.size > 0) return;
  handlersInstalled = false;
  process.off('exit', cleanupSync);
  for (const sig of SIGNALS) process.off(sig, onSignal);
}

function onSignal(sig: NodeJS.Signals): void {
  cleanupSync();
  // Only take the process down if nobody else is handling this signal.
  if (process.listenerCount(sig) <= 1) process.exit(sig === 'SIGINT' ? 130 : 143);
}

/** Signal/exit handlers must finish synchronously, so this shells out with execFileSync. */
function cleanupSync(): void {
  for (const [dir, repo] of LIVE) {
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
    } catch {
      /* fall through to the filesystem sweep */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  }
  LIVE.clear();
}

/** Scrub credential-shaped substrings out of anything we surface or log. */
function redact(s: string): string {
  return s
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|TOKEN))\b(\s*[:=]\s*"?)([^\s"',;}&#]+)/gi,
      '$1$2[redacted]',
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|auth|password)=)([^&\s"'#]+)/gi, '$1[redacted]')
    .replace(/\b(sk|rk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_\-]{16,}\b/g, '[redacted]')
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:[redacted]@');
}

/** Exposed for the CLI's error formatter. */
export { redact as redactSecrets };
