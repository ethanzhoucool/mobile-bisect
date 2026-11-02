import { describe, expect, it } from 'vitest';
import type { CommitResult, CommitSummary } from '@mobile-bisect/core';
import { narrowByKnown, reusedResult, verdictKey, type KnownVerdict } from '../src/verdicts.js';

function commits(n: number): CommitSummary[] {
  return Array.from({ length: n }, (_, index) => {
    const sha = `${String(index).padStart(2, '0')}`.padEnd(40, 'a');
    return { sha, shortSha: sha.slice(0, 7), subject: `c${index}`, author: 'a', authoredAt: '', index };
  });
}

function known(list: CommitSummary[], verdicts: Record<number, 'good' | 'bad'>): Map<string, KnownVerdict> {
  return new Map(
    Object.entries(verdicts).map(([i, state]) => {
      const c = list[Number(i)]!;
      const result: CommitResult = { sha: c.sha, subject: c.subject, author: c.author, state, reason: 'seen' };
      return [c.sha, { result, runId: 'earlier' }];
    }),
  );
}

describe('narrowByKnown', () => {
  const list = commits(10);

  it('narrows to the newest known good and the oldest known bad', () => {
    const out = narrowByKnown(list, known(list, { 2: 'good', 4: 'good', 7: 'bad', 8: 'bad' }));
    expect(out.consistent).toBe(true);
    expect(out.commits.map((c) => c.index)).toEqual([4, 5, 6, 7]);
  });

  it('keeps the range when nothing inside it is known', () => {
    expect(narrowByKnown(list, new Map()).commits).toBe(list);
  });

  it('refuses verdicts that contradict each other', () => {
    const out = narrowByKnown(list, known(list, { 3: 'bad', 6: 'good' }));
    expect(out.consistent).toBe(false);
    expect(out.commits).toBe(list);
  });

  it('refuses verdicts that contradict the boundaries', () => {
    expect(narrowByKnown(list, known(list, { 9: 'good' })).consistent).toBe(false);
    expect(narrowByKnown(list, known(list, { 0: 'bad' })).consistent).toBe(false);
  });
});

describe('verdictKey', () => {
  const base = { flow: { name: 'f', steps: [{ label: 'a' }] }, expect: 'x', platform: 'ios', dryRun: false };

  it('ignores key order and changes with anything a verdict depends on', () => {
    expect(verdictKey(base)).toBe(verdictKey({ dryRun: false, platform: 'ios', expect: 'x', flow: base.flow }));
    expect(verdictKey({ ...base, expect: 'y' })).not.toBe(verdictKey(base));
    expect(verdictKey({ ...base, deviceModel: 'Pixel 7' })).not.toBe(verdictKey(base));
    expect(verdictKey({ ...base, build: { scheme: 'Other' } })).not.toBe(verdictKey(base));
  });
});

describe('reusedResult', () => {
  it('says where it came from and drops paths local to the earlier run', () => {
    const r = reusedResult({
      runId: 'r1',
      result: {
        sha: 's',
        subject: 'x',
        author: 'a',
        state: 'bad',
        reason: 'assertion failed',
        localPaths: ['artifacts/s/run.mp4'],
        videoUrl: 'https://example.test/v.mp4',
        durationMs: 40_000,
      },
    });
    expect(r.reason).toBe('Reused from run r1: assertion failed');
    expect(r.localPaths).toBeUndefined();
    expect(r.videoUrl).toBe('https://example.test/v.mp4');
    expect(r.durationMs).toBe(0);
    // reused again later, it still names the run that tested it
    expect(reusedResult({ runId: 'r2', result: r }).reason).toBe(r.reason);
  });
});
