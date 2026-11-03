/**
 * Verdicts from earlier runs, reused instead of paid for again (`--reuse-verdicts`).
 *
 * A commit's verdict depends on the commit and on everything the run held
 * fixed: the flow, the assertion, the device, how the commit was built and
 * which app it was installed as. When all of that matches an earlier run, the
 * earlier good or bad is the answer a new device run would give. Re-running a
 * search that ended unresolved, moving `--bad` forward to a newer commit, or
 * starting over instead of resuming all cover commits that were already
 * classified, and each one is a build and a device session saved.
 *
 * Known verdicts narrow the range before the search starts, the same way the
 * prebuilt pass does: the newest known-good commit becomes the good boundary
 * and the oldest known-bad commit the bad one. The search then only pays for
 * commits nobody has classified yet.
 *
 * Only `good` and `bad` are reused. A skip says something about that run's
 * device or build, not about the commit, so it is tried again. A commit that
 * earlier runs disagree about is flaky and is run again, and verdicts that
 * contradict each other along the range are not used at all.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RunStore, type CommitResult, type CommitSummary } from '@mobile-bisect/core';

const REUSED = 'Reused from run ';

/** Everything a verdict depends on, other than the commit itself. */
export interface VerdictKeyInput {
  flow: unknown;
  expect: string;
  platform: string;
  deviceModel?: string;
  osVersion?: string;
  framework?: string;
  appId?: string;
  buildId?: string;
  /** The build block after flag overrides: scheme, variant, project dir, … */
  build?: unknown;
  dryRun: boolean;
  /** Dry runs only: the fake runner's verdicts are a function of these. */
  culpritSha?: string;
  flakySha?: string;
}

/** A stable hash of `input`, stored in run.json so later runs can match on it. */
export function verdictKey(input: VerdictKeyInput): string {
  return createHash('sha256').update(stableJson({ v: 1, ...input })).digest('hex');
}

export interface KnownVerdict {
  result: CommitResult;
  /** The run it was recorded in. */
  runId: string;
}

export interface KnownVerdicts {
  bySha: Map<string, KnownVerdict>;
  /** Commits earlier runs disagree about, left to be run again. */
  conflicting: number;
  /** Earlier runs whose key matched. */
  runs: number;
}

/**
 * Good/bad verdicts for `commits` from every earlier run with the same key,
 * newest run first. Runs written before keys existed have none and never match.
 */
export async function loadKnownVerdicts(input: {
  repo: string;
  key: string;
  /** The run being started, which must not count as an earlier one. */
  excludeRunId: string;
  commits: CommitSummary[];
}): Promise<KnownVerdicts> {
  const wanted = new Set(input.commits.map((c) => c.sha));
  const bySha = new Map<string, KnownVerdict>();
  const conflicted = new Set<string>();
  let runs = 0;

  const ids = (await RunStore.list(input.repo)).reverse();
  for (const runId of ids) {
    if (runId === input.excludeRunId) continue;
    let store: RunStore;
    try {
      store = await RunStore.open(input.repo, runId);
    } catch {
      continue;
    }
    if ((await readKey(store.dir)) !== input.key) continue;
    const state = await store.loadState().catch(() => null);
    if (!state) continue;
    runs += 1;

    for (const result of Object.values(state.results)) {
      if (result.state !== 'good' && result.state !== 'bad') continue;
      if (!wanted.has(result.sha) || conflicted.has(result.sha)) continue;
      const seen = bySha.get(result.sha);
      if (!seen) bySha.set(result.sha, { result, runId });
      else if (seen.result.state !== result.state) {
        bySha.delete(result.sha);
        conflicted.add(result.sha);
      }
    }
  }
  return { bySha, conflicting: conflicted.size, runs };
}

/**
 * The result recorded for a reused verdict.
 *
 * It says where it came from, and leaves out the earlier run's local artifact
 * paths, which are relative to that run's directory and would point at
 * nothing from this one.
 */
export function reusedResult(known: KnownVerdict): CommitResult {
  const r = known.result;
  return {
    sha: r.sha,
    subject: r.subject,
    author: r.author,
    state: r.state,
    ...(r.runId !== undefined ? { runId: r.runId } : {}),
    ...(r.assertion !== undefined ? { assertion: r.assertion } : {}),
    ...(r.assertionPassed !== undefined ? { assertionPassed: r.assertionPassed } : {}),
    ...(remote(r.videoUrl) ? { videoUrl: r.videoUrl } : {}),
    ...(remote(r.logsUrl) ? { logsUrl: r.logsUrl } : {}),
    ...(remote(r.networkUrl) ? { networkUrl: r.networkUrl } : {}),
    // A verdict reused twice still names the run that actually tested it.
    reason: r.reason?.startsWith(REUSED)
      ? r.reason
      : `${REUSED}${known.runId}: ${r.reason ?? `the commit was ${r.state} there.`}`,
    durationMs: 0,
    attempt: 0,
  };
}

async function readKey(runDir: string): Promise<string | undefined> {
  try {
    const sidecar = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as {
      verdictKey?: unknown;
    };
    return typeof sidecar.verdictKey === 'string' ? sidecar.verdictKey : undefined;
  } catch {
    return undefined;
  }
}

function remote(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

/** JSON with object keys sorted, so equal inputs always hash the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export interface KnownNarrowing {
  /** The range to search: `commits` itself when nothing could be used. */
  commits: CommitSummary[];
  /** False when known verdicts contradict each other or the boundaries. */
  consistent: boolean;
}

/**
 * The range left once known verdicts are applied.
 *
 * The boundaries count as good and bad, as they do everywhere else, so a
 * known-good commit must sit before every known-bad one. If one does not, an
 * earlier run was wrong somewhere and there is no telling where, so the range
 * is returned untouched rather than narrowed onto a guess.
 */
export function narrowByKnown(
  commits: CommitSummary[],
  known: Map<string, KnownVerdict>,
): KnownNarrowing {
  let lastGood = 0;
  let firstBad = commits.length - 1;
  commits.forEach((c, i) => {
    const state = known.get(c.sha)?.result.state;
    if (state === 'good') lastGood = Math.max(lastGood, i);
    else if (state === 'bad') firstBad = Math.min(firstBad, i);
  });
  // Covers a good after a bad, a known-good --bad and a known-bad --good.
  if (lastGood >= firstBad) return { commits, consistent: false };
  if (lastGood === 0 && firstBad === commits.length - 1) return { commits, consistent: true };
  return { commits: commits.slice(lastGood, firstBad + 1), consistent: true };
}
