/**
 * Test-only helpers. Excluded from the build; never imported by shipped code.
 *
 * `drive()` is the reference CLI loop — nextCandidate -> session -> flow ->
 * record — so the tests exercise the same sequence the real command will.
 */

import { Bisector } from './bisect.js';
import { FakeRunner } from './fake-runner.js';
import { RetryPolicy } from './retry.js';
import type { BisectEvent, BisectMeta, CommitSummary, FlowDefinition } from './types.js';

export interface DriveOptions {
  bisector: Bisector;
  runner: FakeRunner;
  flow: FlowDefinition;
  assertion: string;
  policy?: RetryPolicy;
  /** Stop after this many rounds, simulating a crash mid-run. */
  maxRounds?: number;
  /** Called after each round completes — used to persist state between rounds. */
  afterRound?: (sha: string) => Promise<void> | void;
}

export async function drive(o: DriveOptions): Promise<void> {
  const policy = o.policy ?? new RetryPolicy();
  let rounds = 0;
  for (;;) {
    if (o.maxRounds !== undefined && rounds >= o.maxRounds) return;
    const c = o.bisector.nextCandidate();
    if (!c) return;
    rounds += 1;

    o.runner.setCandidate(c.sha);
    const session = await o.runner.startSession({ platform: 'ios' });
    o.bisector.markRunning(c.sha, {
      streamUrl: session.streamUrl,
      sessionId: session.sessionId,
    });
    await o.runner.installOrLaunch({ sessionId: session.sessionId, buildId: c.sha, resetState: true });

    const outcome = await policy.run(async (attempt) => {
      const r = await o.runner.runFlow({
        sessionId: session.sessionId,
        flow: o.flow,
        assertion: o.assertion,
        onStep: (index, label) => o.bisector.step(c.sha, index, o.flow.steps.length, label),
      });
      // Persist the failed attempt so a resumed run knows it already happened.
      if (r.verdict === 'inconclusive' && attempt < policy.maxAttempts) {
        o.bisector.record({
          sha: c.sha,
          subject: c.subject,
          author: c.author,
          state: 'inconclusive',
          runId: r.runId,
          assertion: o.assertion,
          assertionPassed: false,
          reason: r.reason,
          durationMs: r.durationMs,
          attempt,
        });
      }
      return r;
    });

    const artifacts = await o.runner.collectArtifacts(outcome.result.runId);
    o.bisector.record({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
      state: outcome.state,
      runId: outcome.result.runId,
      assertion: o.assertion,
      assertionPassed: outcome.state === 'good',
      reason: outcome.downgraded ? outcome.reason! : outcome.result.reason,
      durationMs: outcome.result.durationMs,
      attempt: outcome.attempts,
      ...artifacts,
    });
    await o.runner.stopSession(session.sessionId);
    await o.afterRound?.(c.sha);
  }
}

/** Synthetic oldest-first commit list, deterministic shas. */
export function makeCommits(n: number, prefix = 'c'): CommitSummary[] {
  return Array.from({ length: n }, (_, index) => {
    const sha = `${prefix}${String(index).padStart(2, '0')}`.padEnd(40, '0');
    return {
      sha,
      shortSha: sha.slice(0, 7),
      subject: `commit ${index}`,
      author: 'test.author',
      authoredAt: new Date(Date.UTC(2026, 0, 1) + index * 3600_000).toISOString(),
      index,
    };
  });
}

export function makeMeta(totalCommits: number, over: Partial<BisectMeta> = {}): BisectMeta {
  return {
    runId: 'test-run',
    command: 'npx expo-bisect --good A --bad B',
    flowName: 'test-flow',
    goodRef: 'A',
    badRef: 'B',
    expect: 'the thing happens',
    totalCommits,
    plannedRounds: Math.ceil(Math.log2(Math.max(2, totalCommits))),
    ...over,
  };
}

export function makeFlow(labels: string[], name = 'test-flow'): FlowDefinition {
  return { name, steps: labels.map((label) => ({ label })) };
}

/** Collector for the `emit` callback. */
export function recorder(): { events: BisectEvent[]; emit: (e: BisectEvent) => void } {
  const events: BisectEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}

export function stripAt<T extends { at: string }>(events: T[]): Omit<T, 'at'>[] {
  return events.map(({ at: _at, ...rest }) => rest);
}

/** Narrowing filter over the event union. */
export function pick<K extends BisectEvent['type']>(
  events: BisectEvent[],
  type: K,
): Extract<BisectEvent, { type: K }>[] {
  return events.filter((e): e is Extract<BisectEvent, { type: K }> => e.type === type);
}
