import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState } from './model.js';
import type { BisectEvent } from '../types.js';

const SHA = 'a'.repeat(40);

function frame(ordinal: number, path: string): BisectEvent {
  return { type: 'flow.frame', at: new Date(0).toISOString(), sha: SHA, ordinal, path };
}

describe('frames captured while a candidate is still running', () => {
  it('collects them in the order the steps produced them', () => {
    const s = emptyState();
    applyEvent(s, frame(1, 'artifacts/r/step-01-live.png'), 1);
    applyEvent(s, frame(2, 'artifacts/r/step-02-live.png'), 2);

    expect(s.liveFrames.get(SHA)).toEqual([
      'artifacts/r/step-01-live.png',
      'artifacts/r/step-02-live.png',
    ]);
  });

  it('ignores a repeat of a frame it already has, so a replayed log does not double it', () => {
    const s = emptyState();
    applyEvent(s, frame(1, 'artifacts/r/step-01-live.png'), 1);
    applyEvent(s, frame(1, 'artifacts/r/step-01-live.png'), 1);

    expect(s.liveFrames.get(SHA)).toHaveLength(1);
  });

  it("keeps each commit's frames to itself", () => {
    const other = 'b'.repeat(40);
    const s = emptyState();
    applyEvent(s, frame(1, 'one.png'), 1);
    applyEvent(s, { ...frame(1, 'two.png'), sha: other } as BisectEvent, 2);

    expect(s.liveFrames.get(SHA)).toEqual(['one.png']);
    expect(s.liveFrames.get(other)).toEqual(['two.png']);
  });

  it('starts empty, so a phone with no frames yet has nothing to show', () => {
    expect(emptyState().liveFrames.size).toBe(0);
  });
});
