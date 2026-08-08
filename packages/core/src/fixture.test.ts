/**
 * Acceptance test: replaying the reference run must reproduce it event for
 * event. If this file goes red, the demo video and the docs are both wrong.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Bisector } from './bisect.js';
import { FakeRunner } from './fake-runner.js';
import { drive, pick, recorder, stripAt } from './test-helpers.js';
import type { BisectEvent, CommitSummary, FlowDefinition } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../../fixtures/demo-runs/orbit-checkout.jsonl');

const FIXTURE_EVENTS: BisectEvent[] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BisectEvent);

const started = FIXTURE_EVENTS[0];
if (started?.type !== 'search.started') throw new Error('fixture must open with search.started');
const COMMITS: CommitSummary[] = started.commits;
const META = started.meta;
const CULPRIT_INDEX = 41;

const FLOW: FlowDefinition = {
  name: META.flowName,
  steps: [
    'Launch Orbit Store',
    'Open featured product',
    'Tap "Add to cart"',
    'Open cart',
    'Apply coupon SAVE10',
    'Tap "Place order"',
    'Assert order confirmation',
  ].map((label) => ({ label })),
};

// The fixture's exact copy, injected so the replay is byte-identical.
const REASONS = {
  pass: 'Order confirmation heading appeared 1.2s after tapping Place order.',
  fail: 'POST /orders returned 200 but the app stayed on checkout. Order confirmation heading never appeared.',
};

const DIAGNOSIS =
  'POST /orders returned 200 in both builds. Navigation stopped after the response parser returned undefined.';

async function replay() {
  const { events, emit } = recorder();
  const bisector = new Bisector({ commits: COMMITS, meta: META, emit });
  // What the CLI hands over from diagnose(); it rides along on culprit.found.
  bisector.setDiagnosis(DIAGNOSIS);
  const runner = new FakeRunner({
    culpritSha: COMMITS[CULPRIT_INDEX]!.sha,
    commits: COMMITS,
    reasons: REASONS,
  });
  await drive({ bisector, runner, flow: FLOW, assertion: META.expect });
  return { events, bisector };
}

describe('orbit-checkout fixture', () => {
  it('sanity-checks the fixture itself', () => {
    expect(COMMITS).toHaveLength(64);
    expect(COMMITS[40]!.shortSha).toBe('7fa11c8');
    expect(COMMITS[41]!.shortSha).toBe('8d4c2f1');
    expect(META.plannedRounds).toBe(6);
  });

  it('produces exactly 6 rounds with the fixture candidate indices', async () => {
    const { events } = await replay();
    const byIndex = new Map(COMMITS.map((c) => [c.sha, c.index]));
    const rounds = pick(events, 'round.started');

    expect(rounds).toHaveLength(6);
    expect(rounds.map((r) => byIndex.get(r.candidateSha))).toEqual([31, 47, 39, 43, 41, 40]);
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('narrows through the fixture ranges', async () => {
    const { events } = await replay();
    const narrowed = pick(events, 'range.narrowed');
    expect(narrowed.map((n) => n.activeRange)).toEqual([
      [32, 62],
      [32, 46],
      [40, 46],
      [40, 42],
      [40, 40],
      [41, 41],
    ]);
    expect(narrowed.map((n) => n.remaining)).toEqual([31, 15, 7, 3, 1, 0]);
  });

  it('lands on 8d4c2f1 with 7fa11c8 as the last good commit', async () => {
    const { events, bisector } = await replay();
    const found = pick(events, 'culprit.found')[0];
    expect(found?.goodSha).toBe('7fa11c8e0a1c4b9d2f7a6e3c5b8d1a4f9c2e7b60');
    expect(found?.badSha).toBe('8d4c2f19b3e7a5c0d8f2b6a4e9c1d7f3a5b8e204');
    expect(bisector.culprit).toEqual({
      goodSha: COMMITS[40]!.sha,
      badSha: COMMITS[41]!.sha,
    });
    expect(bisector.isComplete).toBe(true);
    expect(bisector.nextCandidate()).toBeNull();
  });

  it('reproduces the fixture event stream verbatim (timestamps aside)', async () => {
    const { events } = await replay();
    // report.ready is the CLI's, not the state machine's.
    const expected = FIXTURE_EVENTS.filter((e) => e.type !== 'report.ready');
    expect(stripAt(events)).toEqual(stripAt(expected));
  });

  it('records a good/bad verdict for every tested commit', async () => {
    const { bisector } = await replay();
    const states = Object.values(bisector.state.results).map((r) => r.state);
    expect(states.filter((s) => s === 'good')).toHaveLength(3);
    expect(states.filter((s) => s === 'bad')).toHaveLength(3);
    expect(bisector.state.round).toBe(6);
  });
});
