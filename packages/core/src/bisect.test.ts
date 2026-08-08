import { describe, expect, it } from 'vitest';

import { Bisector, BisectError } from './bisect.js';
import { makeCommits, makeMeta, pick, recorder } from './test-helpers.js';
import type { CommitResult, CommitState, CommitSummary } from './types.js';

function result(c: CommitSummary, state: CommitState, over: Partial<CommitResult> = {}): CommitResult {
  return { sha: c.sha, subject: c.subject, author: c.author, state, ...over };
}

/** Drive a search where every commit at or after `culprit` is bad. */
function runToCompletion(n: number, culprit: number) {
  const commits = makeCommits(n);
  const { events, emit } = recorder();
  const b = new Bisector({ commits, meta: makeMeta(n), emit });
  const candidates: number[] = [];
  for (;;) {
    const c = b.nextCandidate();
    if (!c) break;
    candidates.push(c.index);
    b.record(result(c, c.index >= culprit ? 'bad' : 'good'));
  }
  return { bisector: b, events, candidates, commits };
}

describe('Bisector — binary search', () => {
  it('walks the fixture indices for 64 commits with the culprit at 41', () => {
    const { candidates, bisector, events } = runToCompletion(64, 41);
    expect(candidates).toEqual([31, 47, 39, 43, 41, 40]);
    expect(pick(events, 'range.narrowed').map((e) => e.activeRange)).toEqual([
      [32, 62],
      [32, 46],
      [40, 46],
      [40, 42],
      [40, 40],
      [41, 41],
    ]);
    expect(bisector.culprit).toEqual({ goodSha: makeCommits(64)[40]!.sha, badSha: makeCommits(64)[41]!.sha });
  });

  it('finds the culprit at every interior position', () => {
    const n = 33;
    for (let culprit = 1; culprit <= n - 1; culprit++) {
      const { bisector, commits } = runToCompletion(n, culprit);
      expect(bisector.culprit).toEqual({
        goodSha: commits[culprit - 1]!.sha,
        badSha: commits[culprit]!.sha,
      });
    }
  });

  it('emits search.started with the meta and commits up front', () => {
    const commits = makeCommits(8);
    const { events, emit } = recorder();
    const meta = makeMeta(8);
    new Bisector({ commits, meta, emit });
    expect(events[0]).toMatchObject({ type: 'search.started', meta, commits });
  });
});

describe('Bisector — edge cases', () => {
  it('resolves a 2-commit range with no rounds at all', () => {
    const commits = makeCommits(2);
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(2), emit });
    expect(b.isComplete).toBe(true);
    expect(b.nextCandidate()).toBeNull();
    expect(b.culprit).toEqual({ goodSha: commits[0]!.sha, badSha: commits[1]!.sha });
    expect(pick(events, 'round.started')).toHaveLength(0);
    expect(pick(events, 'culprit.found')).toHaveLength(1);
  });

  it('resolves a 3-commit range in one round (good)', () => {
    const { candidates, bisector, commits } = runToCompletion(3, 2);
    expect(candidates).toEqual([1]);
    expect(bisector.culprit).toEqual({ goodSha: commits[1]!.sha, badSha: commits[2]!.sha });
  });

  it('resolves a 3-commit range in one round (bad)', () => {
    const { candidates, bisector, commits } = runToCompletion(3, 1);
    expect(candidates).toEqual([1]);
    expect(bisector.culprit).toEqual({ goodSha: commits[0]!.sha, badSha: commits[1]!.sha });
  });

  it('resolves a 4-commit range (interior of size 2) in two rounds', () => {
    expect(runToCompletion(4, 1).candidates).toEqual([1]);
    expect(runToCompletion(4, 2).candidates).toEqual([1, 2]);
    expect(runToCompletion(4, 3).candidates).toEqual([1, 2]);
    const { bisector, commits } = runToCompletion(4, 3);
    expect(bisector.culprit).toEqual({ goodSha: commits[2]!.sha, badSha: commits[3]!.sha });
  });

  it('blames the bad boundary when the whole interior is good', () => {
    const { bisector, commits } = runToCompletion(16, 15);
    expect(bisector.culprit).toEqual({ goodSha: commits[14]!.sha, badSha: commits[15]!.sha });
  });

  it('blames the first interior commit when the whole interior is bad', () => {
    const { bisector, commits } = runToCompletion(16, 1);
    expect(bisector.culprit).toEqual({ goodSha: commits[0]!.sha, badSha: commits[1]!.sha });
  });

  it('rejects fewer than 2 commits', () => {
    const { emit } = recorder();
    expect(() => new Bisector({ commits: makeCommits(1), meta: makeMeta(1), emit })).toThrow(BisectError);
    expect(() => new Bisector({ commits: [], meta: makeMeta(0), emit })).toThrow(/at least 2 commits/);
  });

  it('rejects a record() for a commit that is not the active candidate', () => {
    const commits = makeCommits(8);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(8), emit });
    const c = b.nextCandidate()!;
    expect(() => b.record(result(commits[0]!, 'good'))).toThrow(/does not match the active candidate/);
    expect(() => b.markRunning(commits[6]!.sha)).toThrow(/does not match the active candidate/);
    b.record(result(c, 'good'));
    expect(() => b.record(result(c, 'good'))).toThrow(/no active candidate/);
  });

  it('returns null from nextCandidate() once complete and refuses further records', () => {
    const { bisector, commits } = runToCompletion(8, 5);
    expect(bisector.nextCandidate()).toBeNull();
    expect(bisector.nextCandidate()).toBeNull();
    expect(() => bisector.record(result(commits[3]!, 'good'))).toThrow(/already complete/);
  });
});

describe('Bisector — skip', () => {
  it('walks outward from the midpoint when a commit is skipped', () => {
    const commits = makeCommits(16);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });

    const first = b.nextCandidate()!;
    expect(first.index).toBe(7); // floor((1+14)/2)
    b.record(result(first, 'skipped'));

    const second = b.nextCandidate()!;
    expect(second.index).toBe(6); // mid-1
    b.record(result(second, 'skipped'));

    const third = b.nextCandidate()!;
    expect(third.index).toBe(8); // mid+1
    b.record(result(third, 'skipped'));

    expect(b.nextCandidate()!.index).toBe(5); // mid-2
  });

  it('keeps the range unchanged when a candidate is skipped', () => {
    const commits = makeCommits(16);
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    b.record(result(b.nextCandidate()!, 'skipped'));
    const [narrowed] = pick(events, 'range.narrowed');
    expect(narrowed!.activeRange).toEqual([1, 14]);
    expect(narrowed!.remaining).toBe(14);
  });

  it('still converges when a skipped commit sits on the midpoint', () => {
    const commits = makeCommits(16);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    const culprit = 11;
    let skippedOnce = false;
    for (;;) {
      const c = b.nextCandidate();
      if (!c) break;
      if (!skippedOnce && c.index === 7) {
        skippedOnce = true;
        b.record(result(c, 'skipped'));
        continue;
      }
      b.record(result(c, c.index >= culprit ? 'bad' : 'good'));
    }
    expect(b.culprit).toEqual({ goodSha: commits[10]!.sha, badSha: commits[11]!.sha });
  });

  it('fails with the range in the message when every candidate is skipped', () => {
    const commits = makeCommits(5); // interior is [1, 3]
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(5), emit });
    for (;;) {
      const c = b.nextCandidate();
      if (!c) break;
      b.record(result(c, 'skipped'));
    }
    const [failed] = pick(events, 'search.failed');
    expect(failed?.message).toMatch(/\[1, 3\]/);
    expect(failed?.message).toMatch(/skipped/);
    expect(b.isComplete).toBe(true);
    expect(b.culprit).toBeUndefined();
  });
});

describe('Bisector — inconclusive', () => {
  it('does not narrow the range and keeps the same candidate active', () => {
    const commits = makeCommits(16);
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    const c = b.nextCandidate()!;
    b.record(result(c, 'inconclusive'));

    expect(pick(events, 'range.narrowed')).toHaveLength(0);
    expect(b.attemptsFor(c.sha)).toBe(1);
    expect(b.nextCandidate()).toBe(c); // retry the same commit, not a new round
    expect(pick(events, 'round.started')).toHaveLength(1);
  });

  it('counts attempts and narrows once the retry lands a verdict', () => {
    const commits = makeCommits(16);
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    const c = b.nextCandidate()!;
    b.record(result(c, 'inconclusive'));
    b.record(result(c, 'good'));

    expect(b.attemptsFor(c.sha)).toBe(2);
    expect(b.state.results[c.sha]!.state).toBe('good');
    expect(b.state.results[c.sha]!.attempt).toBe(2);
    expect(pick(events, 'range.narrowed')[0]!.activeRange).toEqual([8, 14]);
    expect(pick(events, 'commit.completed')).toHaveLength(2);
  });

  it('downgrades to skipped when the retry is inconclusive too', () => {
    const commits = makeCommits(16);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    const c = b.nextCandidate()!;
    b.record(result(c, 'inconclusive'));
    b.record(result(c, 'skipped', { attempt: 2 }));
    expect(b.attemptsFor(c.sha)).toBe(2);
    expect(b.nextCandidate()!.index).toBe(6);
  });
});

describe('Bisector — event bookkeeping', () => {
  it('emits flow steps and running markers for the active candidate only', () => {
    const commits = makeCommits(8);
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(8), emit });
    const c = b.nextCandidate()!;
    b.markRunning(c.sha, { sessionId: 's1', streamUrl: 'https://stream.example/s1' });
    b.step(c.sha, 1, 2, 'Launch');
    b.step(c.sha, 2, 2, 'Assert');
    expect(pick(events, 'commit.running')[0]).toMatchObject({ sha: c.sha, sessionId: 's1' });
    expect(pick(events, 'flow.step').map((e) => e.label)).toEqual(['Launch', 'Assert']);
    expect(() => b.step('nope', 1, 2, 'Launch')).toThrow(BisectError);
  });

  it('keeps state.activeRange and state.round in step with the events', () => {
    const commits = makeCommits(64);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(64), emit });
    expect(b.state.activeRange).toEqual([1, 62]);
    const c = b.nextCandidate()!;
    expect(b.state.round).toBe(1);
    b.record(result(c, 'good'));
    expect(b.state.activeRange).toEqual([32, 62]);
    expect(b.state.version).toBe(1);
    expect(b.state.finishedAt).toBeUndefined();
  });

  it('carries a diagnosis onto the persisted culprit', () => {
    const commits = makeCommits(4);
    const { emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(4), emit });
    b.setDiagnosis('the parser returned undefined');
    for (;;) {
      const c = b.nextCandidate();
      if (!c) break;
      b.record(result(c, c.index >= 2 ? 'bad' : 'good'));
    }
    expect(b.state.culprit?.diagnosis).toBe('the parser returned undefined');
    expect(b.state.finishedAt).toBeTypeOf('string');
  });
});
