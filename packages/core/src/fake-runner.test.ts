import { describe, expect, it } from 'vitest';

import { Bisector } from './bisect.js';
import { FakeRunner } from './fake-runner.js';
import { drive, makeCommits, makeFlow, makeMeta, pick, recorder } from './test-helpers.js';

const FLOW = makeFlow(['Launch', 'Open cart', 'Tap "Place order"', 'Assert confirmation']);

describe('FakeRunner', () => {
  const commits = makeCommits(16);
  const culprit = commits[9]!;

  it('fails at and after the culprit, passes before it', () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    expect(r.verdictFor(commits[8]!.sha)).toBe('pass');
    expect(r.verdictFor(commits[9]!.sha)).toBe('fail');
    expect(r.verdictFor(commits[15]!.sha)).toBe('fail');
  });

  it('binds a session to a commit and reports fixture-shaped ids', async () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    r.setCandidate(commits[3]!.sha);
    const s = await r.startSession({ platform: 'ios' });
    expect(s.sessionId).toBe(`sess_${commits[3]!.shortSha}`);
    expect(s.streamUrl).toBe(`https://stream.revyl.ai/demo/${commits[3]!.shortSha}`);
    expect(s.deviceModel).toBe('iPhone 15 Pro');

    await r.installOrLaunch({ sessionId: s.sessionId, buildId: commits[3]!.sha });
    const out = await r.runFlow({ sessionId: s.sessionId, flow: FLOW, assertion: 'it works' });
    expect(out.runId).toBe(`run_${commits[3]!.shortSha}`);
    expect(out.verdict).toBe('pass');
    expect(out.stepsCompleted).toBe(4);
    expect(out.durationMs).toBe(42_000 + 3 * 137);
  });

  it('infers the commit from a bundle url when setCandidate was not used', async () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    const s = await r.startSession({ platform: 'android' });
    await r.installOrLaunch({
      sessionId: s.sessionId,
      bundleUrl: `http://127.0.0.1:8081/index.bundle?sha=${commits[12]!.sha}`,
    });
    const out = await r.runFlow({ sessionId: s.sessionId, flow: FLOW, assertion: 'it works' });
    expect(out.verdict).toBe('fail');
    expect(s.deviceModel).toBe('Pixel 7');
  });

  it('reports every flow step in order', async () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    r.setCandidate(commits[2]!.sha);
    const s = await r.startSession({ platform: 'ios' });
    await r.installOrLaunch({ sessionId: s.sessionId, buildId: commits[2]!.sha });
    const seen: [number, string][] = [];
    await r.runFlow({
      sessionId: s.sessionId,
      flow: FLOW,
      assertion: 'it works',
      onStep: (i, label) => void seen.push([i, label]),
    });
    expect(seen).toEqual([
      [1, 'Launch'],
      [2, 'Open cart'],
      [3, 'Tap "Place order"'],
      [4, 'Assert confirmation'],
    ]);
  });

  it('is inconclusive on the first attempt for a flaky sha, then decisive', async () => {
    const flaky = commits[7]!;
    const r = new FakeRunner({ culpritSha: culprit.sha, commits, flakySha: flaky.sha });
    r.setCandidate(flaky.sha);
    const s = await r.startSession({ platform: 'ios' });
    await r.installOrLaunch({ sessionId: s.sessionId, buildId: flaky.sha });

    const first = await r.runFlow({ sessionId: s.sessionId, flow: FLOW, assertion: 'it works' });
    expect(first.verdict).toBe('inconclusive');
    expect(first.stepsCompleted).toBeLessThan(FLOW.steps.length);
    expect(first.reason).toMatch(/dropped at step/);

    const second = await r.runFlow({ sessionId: s.sessionId, flow: FLOW, assertion: 'it works' });
    expect(second.verdict).toBe('pass');
  });

  it('returns artifact urls keyed by the run id', async () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    const a = await r.collectArtifacts(`run_${commits[5]!.shortSha}`);
    expect(a.videoUrl).toContain(commits[5]!.shortSha);
    expect(a.screenshots).toHaveLength(2);
    expect(a.logsUrl).toMatch(/logs\.json$/);
    expect(a.networkUrl).toMatch(/network\.har$/);
  });

  it('refuses a run for an unknown session and an unknown culprit', async () => {
    const r = new FakeRunner({ culpritSha: culprit.sha, commits });
    await expect(r.runFlow({ sessionId: 'nope', flow: FLOW, assertion: 'x' })).rejects.toThrow(
      /unknown session/,
    );
    expect(() => new FakeRunner({ culpritSha: 'deadbeef', commits })).toThrow(/not in the commits list/);
  });

  it('drives a whole bisect to the seeded culprit, retrying the flaky commit', async () => {
    const { events, emit } = recorder();
    const b = new Bisector({ commits, meta: makeMeta(16), emit });
    // The first candidate is index 7; make that one flaky so the retry path runs.
    const runner = new FakeRunner({ culpritSha: culprit.sha, commits, flakySha: commits[7]!.sha });
    await drive({ bisector: b, runner, flow: FLOW, assertion: 'the confirmation appears' });

    expect(b.culprit).toEqual({ goodSha: commits[8]!.sha, badSha: commits[9]!.sha });
    expect(b.attemptsFor(commits[7]!.sha)).toBe(2);
    const completed = pick(events, 'commit.completed');
    expect(completed.filter((e) => e.result.state === 'inconclusive')).toHaveLength(1);
    expect(completed.at(-1)!.result.attempt).toBe(1);
  });
});
