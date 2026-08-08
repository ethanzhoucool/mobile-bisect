import { describe, expect, it, vi } from 'vitest';

import { RetryPolicy, verdictToState } from './retry.js';
import type { RunVerdict } from './types.js';

const run = (verdict: RunVerdict) => ({ verdict, runId: 'r' });

describe('RetryPolicy.decide', () => {
  const p = new RetryPolicy();

  it('accepts a verdict immediately', () => {
    expect(p.decide('pass', 1)).toEqual({ action: 'accept', state: 'good' });
    expect(p.decide('fail', 1)).toEqual({ action: 'accept', state: 'bad' });
  });

  it('retries an inconclusive run exactly once', () => {
    expect(p.decide('inconclusive', 1)).toEqual({ action: 'retry', attempt: 2 });
    expect(p.decide('inconclusive', 2)).toMatchObject({ action: 'downgrade', state: 'skipped' });
  });

  it('honours a custom attempt budget', () => {
    const three = new RetryPolicy({ maxAttempts: 3 });
    expect(three.decide('inconclusive', 2)).toEqual({ action: 'retry', attempt: 3 });
    expect(three.decide('inconclusive', 3)).toMatchObject({ action: 'downgrade' });
  });

  it('rejects a nonsense budget', () => {
    expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(/>= 1/);
    expect(() => new RetryPolicy({ maxAttempts: 1.5 })).toThrow(/integer/);
  });
});

describe('RetryPolicy.run', () => {
  it('runs once when the first attempt is decisive', async () => {
    const attempt = vi.fn(async () => run('fail'));
    const out = await new RetryPolicy().run(attempt);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ attempts: 1, state: 'bad', downgraded: false });
  });

  it('retries once and accepts the second verdict', async () => {
    const verdicts: RunVerdict[] = ['inconclusive', 'pass'];
    const attempt = vi.fn(async (n: number) => run(verdicts[n - 1]!));
    const out = await new RetryPolicy().run(attempt);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenLastCalledWith(2);
    expect(out).toMatchObject({ attempts: 2, state: 'good', downgraded: false });
  });

  it('downgrades to skipped after two inconclusive attempts', async () => {
    const attempt = vi.fn(async () => run('inconclusive'));
    const out = await new RetryPolicy().run(attempt);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(out.state).toBe('skipped');
    expect(out.downgraded).toBe(true);
    expect(out.reason).toMatch(/Inconclusive on 2 of 2 attempts/);
  });

  it('never retries more than the budget', async () => {
    const attempt = vi.fn(async () => run('inconclusive'));
    await new RetryPolicy({ maxAttempts: 4 }).run(attempt);
    expect(attempt).toHaveBeenCalledTimes(4);
  });
});

describe('verdictToState', () => {
  it('maps runner verdicts onto commit states', () => {
    expect(verdictToState('pass')).toBe('good');
    expect(verdictToState('fail')).toBe('bad');
    expect(verdictToState('inconclusive')).toBe('inconclusive');
  });
});
