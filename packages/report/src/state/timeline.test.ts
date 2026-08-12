import { describe, expect, it } from 'vitest';
import { buildTimeline, IDLE_KEEP_MS } from './timeline.js';
import type { BisectEvent } from '../types.js';

const SHA = 'a'.repeat(40);

const at = (s: number) => new Date(s * 1000).toISOString();

/**
 * One round as it really arrives: the round opens, the candidate compiles for
 * 75s, the device reports in, then four steps ten seconds apart.
 */
function oneRound(): BisectEvent[] {
  return [
    { type: 'round.started', at: at(0), round: 1, activeRange: [0, 5], candidateSha: SHA },
    { type: 'commit.running', at: at(75), sha: SHA },
    { type: 'flow.step', at: at(85), sha: SHA, index: 1, total: 4, label: 'one' },
    { type: 'flow.step', at: at(95), sha: SHA, index: 2, total: 4, label: 'two' },
    { type: 'flow.step', at: at(105), sha: SHA, index: 3, total: 4, label: 'three' },
    { type: 'flow.step', at: at(115), sha: SHA, index: 4, total: 4, label: 'four' },
  ];
}

describe('skipping the stretches where nothing happens', () => {
  it('leaves the timeline alone by default', () => {
    const tl = buildTimeline(oneRound());
    expect(tl.marks.map((m) => m.at)).toEqual([0, 75_000, 85_000, 95_000, 105_000, 115_000]);
  });

  it('collapses the compile, which is the long one with nothing in it', () => {
    const tl = buildTimeline(oneRound(), { skipIdle: true });
    expect(tl.marks[1]!.at).toBe(IDLE_KEEP_MS);
  });

  it('keeps the pace between steps, where the gaps are the content', () => {
    const tl = buildTimeline(oneRound(), { skipIdle: true });
    const [, , s1, s2, s3, s4] = tl.marks.map((m) => m.at);
    // A step taking ten seconds is the agent working, not dead air, even
    // though it is longer than the waits that do get collapsed.
    expect(s2! - s1!).toBe(10_000);
    expect(s3! - s2!).toBe(10_000);
    expect(s4! - s3!).toBe(10_000);
  });

  it('shortens the whole run, which is the point', () => {
    const full = buildTimeline(oneRound());
    const short = buildTimeline(oneRound(), { skipIdle: true });
    expect(short.duration).toBeLessThan(full.duration / 2);
  });

  it('never reorders events', () => {
    const tl = buildTimeline(oneRound(), { skipIdle: true });
    const times = tl.marks.map((m) => m.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('reports the round ticks and the culprit against the collapsed clock', () => {
    const evs: BisectEvent[] = [
      ...oneRound(),
      { type: 'culprit.found', at: at(120), goodSha: SHA, badSha: SHA },
    ];
    const tl = buildTimeline(evs, { skipIdle: true });

    expect(tl.roundStarts[0]!.at).toBe(0);
    // 120s of wall clock, less the two waits this round contained: a 75s
    // compile and a 10s install, each now worth IDLE_KEEP_MS.
    const saved = 75_000 - IDLE_KEEP_MS + (10_000 - IDLE_KEEP_MS);
    expect(tl.culpritAt).toBe(120_000 - saved);
  });

  it('collapses the wait before the first step as well as the compile', () => {
    // Device up at 75s, first step only at 100s: install and launch, nothing to see.
    const slowLaunch: BisectEvent[] = [
      { type: 'round.started', at: at(0), round: 1, activeRange: [0, 5], candidateSha: SHA },
      { type: 'commit.running', at: at(75), sha: SHA },
      { type: 'flow.step', at: at(100), sha: SHA, index: 1, total: 4, label: 'one' },
    ];
    const tl = buildTimeline(slowLaunch, { skipIdle: true });
    expect(tl.marks[2]!.at).toBe(2 * IDLE_KEEP_MS);
  });
});
