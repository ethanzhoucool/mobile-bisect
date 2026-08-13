/**
 * "N of 63 remain" is the only number in the header that changes, so it has to
 * mean something exact: how many commits could still be to blame. The known-good
 * base never can be, and the commit above the untested interior always can.
 */

import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState, pendingKind, remainingCount } from './model.js';
import type { BisectEvent, CommitSummary } from '../types.js';

function commits(n: number): CommitSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: String(i).padStart(40, '0'),
    shortSha: String(i).padStart(7, '0'),
    subject: `commit ${i}`,
    author: 'someone',
    authoredAt: new Date(0).toISOString(),
    index: i,
  }));
}

function started(n: number): BisectEvent {
  return {
    type: 'search.started',
    at: new Date(0).toISOString(),
    meta: {
      runId: 'r',
      command: 'mobile-bisect run',
      flowName: 'checkout',
      goodRef: 'v1',
      badRef: 'HEAD',
      expect: 'it works',
      totalCommits: n,
      plannedRounds: 6,
      flowSteps: 3,
    },
    commits: commits(n),
  } as BisectEvent;
}

function narrowed(lo: number, hi: number): BisectEvent {
  return {
    type: 'range.narrowed',
    at: new Date(0).toISOString(),
    round: 1,
    activeRange: [lo, hi],
    remaining: hi - lo + 1,
  } as BisectEvent;
}

describe('remainingCount', () => {
  it('starts at every commit except the known-good base', () => {
    const s = emptyState();
    applyEvent(s, started(64), 1);
    // 64 commits, 63 of which could be the first bad one.
    expect(remainingCount(s)).toBe(63);
  });

  it('never exceeds the number of suspects the header divides by', () => {
    for (const n of [2, 3, 8, 64]) {
      const s = emptyState();
      applyEvent(s, started(n), 1);
      expect(remainingCount(s)).toBeLessThanOrEqual(n - 1);
    }
  });

  it('counts the commit above the interior, which is still a suspect', () => {
    const s = emptyState();
    applyEvent(s, started(64), 1);
    // Everything up to 32 is good: suspects are 33..63.
    applyEvent(s, narrowed(33, 62), 2);
    expect(remainingCount(s)).toBe(31);
    // Down to one untested commit: it, or the one after it.
    applyEvent(s, narrowed(41, 41), 3);
    expect(remainingCount(s)).toBe(2);
  });

  it('is 0 before a search has started', () => {
    expect(remainingCount(emptyState())).toBe(0);
  });
});

describe('pendingKind', () => {
  it('says what the phone is waiting on before the flow reports a step', () => {
    expect(pendingKind('scheduled', undefined, false)).toBe('building');
    expect(pendingKind('running', undefined, false)).toBe('starting');
    expect(pendingKind('running', 0, false)).toBe('starting');
  });

  it('stops claiming the device is starting once a step has come back', () => {
    // The phone showed "starting the device" through step 7 of 7, which is a
    // state the run had long left.
    expect(pendingKind('running', 1, false)).toBeUndefined();
    expect(pendingKind('running', 7, false)).toBeUndefined();
  });

  it('is nothing at all once the candidate has a verdict', () => {
    for (const state of ['good', 'bad', 'skipped', 'inconclusive'] as const) {
      expect(pendingKind(state, 7, true)).toBeUndefined();
    }
  });
});
