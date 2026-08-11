/**
 * Searching the builds that already exist before compiling anything.
 *
 * A binary search over commits compiles roughly log2(n) of them. But most teams
 * already have builds in Revyl for the commits CI touched, and installing a
 * build that exists costs seconds where compiling the same commit costs a
 * minute or more. So the search runs in two passes:
 *
 *   1. Bisect the commits that already have a build. Every test is an install,
 *      so this narrows the range for almost nothing.
 *   2. Bisect the commits in the gap that survived, compiling only those.
 *
 * For a repo with nightly builds, pass 1 turns 500 commits into the ten between
 * two nightlies without compiling once, and pass 2 compiles three. Without it,
 * the same search compiles nine.
 *
 * The whole thing rests on being able to say which commit a build came from,
 * which is a guess made carefully: see `resolveBuildCommits`.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CommitSummary, Platform } from '@mobile-bisect/core';

const execFileAsync = promisify(execFile);

export interface BuildVersionLike {
  buildId: string;
  version: string;
}

export interface PrebuiltCommit {
  commit: CommitSummary;
  buildId: string;
  /** The label the build carried, kept for the terminal line. */
  version: string;
}

/**
 * Anything in a build label that could be an abbreviated or full commit hash.
 *
 * Deliberately loose, because the filter that follows is exact: every token is
 * handed to `git rev-parse`, which rejects what is not a commit in this repo.
 * `revyl-dark-20260731` yields `20260731`, which looks like a hash and is a
 * date; git says no and it is dropped. A looser regex costs one git call, a
 * tighter one silently loses `main-3efb0b3`.
 */
const SHA_LIKE = /\b[0-9a-f]{7,40}\b/gi;

export function shaCandidates(label: string): string[] {
  return [...new Set(label.toLowerCase().match(SHA_LIKE) ?? [])];
}

/**
 * Builds whose label names a commit inside the range, oldest commit first.
 *
 * A build is only usable here if we can say which commit it was built from,
 * and the label is the only place that says so. Where it does not, the build
 * is skipped rather than guessed at: installing a build from the wrong commit
 * would produce a verdict about a commit that was never tested.
 */
export async function resolveBuildCommits(
  repo: string,
  builds: BuildVersionLike[],
  commits: CommitSummary[],
): Promise<PrebuiltCommit[]> {
  const indexBySha = new Map(commits.map((c, i) => [c.sha, i]));
  const found = new Map<string, PrebuiltCommit>();

  for (const build of builds) {
    for (const token of shaCandidates(build.version)) {
      const sha = await resolveCommit(repo, token);
      if (!sha) continue;
      const index = indexBySha.get(sha);
      if (index === undefined) continue; // real commit, outside this range

      // Several builds can name one commit; the first wins, and `build list`
      // returns newest first, so that is the most recent build of it.
      if (!found.has(sha)) {
        found.set(sha, { commit: commits[index]!, buildId: build.buildId, version: build.version });
      }
      break;
    }
  }

  return [...found.values()].sort(
    (a, b) => indexBySha.get(a.commit.sha)! - indexBySha.get(b.commit.sha)!,
  );
}

/** `git rev-parse` the token, or undefined when it is not a commit here. */
async function resolveCommit(repo: string, token: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', `${token}^{commit}`],
      { maxBuffer: 1024 * 1024 },
    );
    const sha = stdout.trim();
    return sha.length === 40 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The chain a build-level bisect walks: the known-good boundary, every
 * pre-built commit strictly between the boundaries, and the known-bad boundary.
 *
 * The boundaries are included without needing builds of their own. Their
 * verdicts are given: that is what makes them boundaries.
 */
export function buildChain(
  commits: CommitSummary[],
  prebuilt: PrebuiltCommit[],
): PrebuiltCommit[] | undefined {
  if (commits.length < 3) return undefined;
  const first = commits[0]!;
  const last = commits[commits.length - 1]!;

  const interior = prebuilt.filter((p) => p.commit.sha !== first.sha && p.commit.sha !== last.sha);
  // With nothing between the boundaries there is nothing to narrow, and the
  // pass would cost two device runs to learn what we already knew.
  if (interior.length === 0) return undefined;

  return [
    { commit: first, buildId: '', version: 'known good' },
    ...interior,
    { commit: last, buildId: '', version: 'known bad' },
  ];
}

/**
 * The commit range left after the build pass.
 *
 * `goodSha` is the newest pre-built commit that still passed and `badSha` the
 * oldest that failed, so the first bad commit is somewhere in between. Both
 * ends are kept: the search that follows needs its own boundaries, and these
 * two have verdicts already.
 */
export function narrowedRange(
  commits: CommitSummary[],
  goodSha: string,
  badSha: string,
): CommitSummary[] {
  const lo = commits.findIndex((c) => c.sha === goodSha);
  const hi = commits.findIndex((c) => c.sha === badSha);
  if (lo < 0 || hi < 0 || hi <= lo) return commits;
  return commits.slice(lo, hi + 1);
}

// ---------------------------------------------------------------------------
// The pass itself
// ---------------------------------------------------------------------------

export interface NarrowInput {
  chain: PrebuiltCommit[];
  /** Runs one pre-built commit and says whether the assertion held. */
  test: (entry: PrebuiltCommit) => Promise<'good' | 'bad' | 'skip'>;
  onNote?: (line: string) => void;
}

export interface NarrowResult {
  goodSha: string;
  badSha: string;
  /** How many pre-built commits were actually installed and run. */
  tested: number;
}

/**
 * Binary search over the pre-built chain.
 *
 * Index 0 and the last entry are the boundaries and are never tested, exactly
 * as in the commit search: their verdicts are what defines the range. A commit
 * that cannot be classified is dropped from the chain rather than blamed, and
 * the search continues with what is left, so one bad build does not sink the
 * pass.
 */
export async function narrowByBuilds(input: NarrowInput): Promise<NarrowResult> {
  const { chain, test, onNote } = input;
  let lo = 1;
  let hi = chain.length - 2;
  let good = chain[0]!;
  let bad = chain[chain.length - 1]!;
  let tested = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const entry = chain[mid]!;
    const verdict = await test(entry);
    tested += 1;

    if (verdict === 'skip') {
      onNote?.(`  ${entry.commit.shortSha} could not be classified from its build, skipping it`);
      // Drop it and carry on; the range is unchanged because it told us nothing.
      chain.splice(mid, 1);
      hi -= 1;
      continue;
    }

    if (verdict === 'good') {
      good = entry;
      lo = mid + 1;
    } else {
      bad = entry;
      hi = mid - 1;
    }
  }

  return { goodSha: good.commit.sha, badSha: bad.commit.sha, tested };
}

/**
 * The app id, from the project's own Revyl config.
 *
 * Listing an app's builds needs its id, and a project that builds through
 * Revyl already declares one in `.revyl/config.yaml`. Requiring it to be
 * repeated in `mobile-bisect.config.ts` just to enable this pass would mean
 * most projects silently never get it.
 *
 * Prefers the platform's own id over the shared one, matching how `revyl
 * build` resolves it.
 */
export async function appIdFromRevylConfig(
  repo: string,
  platform: Platform,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(repo, '.revyl', 'config.yaml'), 'utf8');
  } catch {
    return undefined;
  }

  const lines = text.split('\n');
  const platformsAt = lines.findIndex((l) => /^\s*platforms:\s*$/.test(l));
  const platformsIndent = platformsAt >= 0 ? indentOf(lines[platformsAt]!) : -1;

  // Where the platforms block ends, so a shared id can be told apart from
  // another platform's. Without this, an ios search happily takes android's.
  let platformsEnd = lines.length;
  if (platformsAt >= 0) {
    for (let i = platformsAt + 1; i < lines.length; i++) {
      if (lines[i]!.trim() && indentOf(lines[i]!) <= platformsIndent) {
        platformsEnd = i;
        break;
      }
    }
  }

  // Our platform's own block wins.
  if (platformsAt >= 0) {
    const keyAt = lines.findIndex(
      (l, i) =>
        i > platformsAt &&
        i < platformsEnd &&
        new RegExp(`^\\s*${platform}[a-z0-9-]*:\\s*$`).test(l),
    );
    if (keyAt >= 0) {
      const keyIndent = indentOf(lines[keyAt]!);
      for (let i = keyAt + 1; i < platformsEnd; i++) {
        if (lines[i]!.trim() && indentOf(lines[i]!) <= keyIndent) break;
        const id = appIdOn(lines[i]!);
        if (id) return id;
      }
    }
  }

  // Otherwise a shared id, but only one declared outside the platforms block.
  for (let i = 0; i < lines.length; i++) {
    if (platformsAt >= 0 && i > platformsAt && i < platformsEnd) continue;
    const id = appIdOn(lines[i]!);
    if (id) return id;
  }
  return undefined;
}

function appIdOn(line: string): string | undefined {
  return /^\s*app_id:\s*["']?([0-9a-f-]{16,})["']?\s*$/i.exec(line)?.[1];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The app id to list builds with.
 *
 * A flow's `appId` is a human label as often as an id, and `revyl build list`
 * only takes a name it can resolve or a UUID. `.revyl/config.yaml` is where a
 * project records the real one, so a UUID from anywhere beats a bare name.
 */
export function preferResolvableAppId(...candidates: Array<string | undefined>): string | undefined {
  const present = candidates.filter((c): c is string => !!c && c.trim().length > 0);
  return present.find((c) => UUID.test(c)) ?? present[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
