import { describe, expect, it } from 'vitest';
import { parseStepOutcome, type StepOutcome } from './cli-adapter.js';
import { classify, isInfraFailure } from './classify.js';
import { fail, ok, recordedErrors } from './fixtures.testutil.js';

const passing = () => parseStepOutcome(ok('device-validation-pass'));
const failing = () =>
  parseStepOutcome({ ...ok('device-validation-fail'), code: 1, stderr: 'Error: validation failed' });

function outcome(over: Partial<StepOutcome> = {}): StepOutcome {
  return { ok: false, workerResponded: true, code: 1, timedOut: false, stderr: '', ...over };
}

describe('isInfraFailure', () => {
  it('does not treat a failing assertion as infrastructure', () => {
    expect(isInfraFailure(failing())).toBe(false);
  });

  it.each(Object.entries(recordedErrors()))('treats the recorded %s error as infrastructure', (_name, rec) => {
    if (rec.stage === 'validation') return; // that one is the app answering "no"
    expect(isInfraFailure(outcome({ stderr: rec.stderr, workerResponded: false }))).toBe(true);
  });

  it.each([
    'Error: no active session',
    'Error: session not found',
    'Error: backend device control request failed: context deadline exceeded',
    'Error: Installation failed',
    'Error: unauthorized',
    'Error: connection refused',
  ])('recognises "%s"', (stderr) => {
    expect(isInfraFailure(outcome({ stderr }))).toBe(true);
  });

  it('treats a timeout or a failed spawn as infrastructure whatever the exit code', () => {
    expect(isInfraFailure(outcome({ code: 0, timedOut: true }))).toBe(true);
    expect(isInfraFailure(outcome({ code: -1, spawnError: 'ENOENT: no such file' }))).toBe(true);
  });

  it('treats an unrecognised failure with no envelope as infrastructure, not as a fail', () => {
    expect(isInfraFailure(outcome({ stderr: 'Error: something new', workerResponded: false }))).toBe(true);
  });

  it('is not fooled by a clean exit', () => {
    expect(isInfraFailure(outcome({ ok: true, code: 0 }))).toBe(false);
  });
});

describe('classify, the verdict table', () => {
  it('pass: the worker evaluated the assertion and the app answered yes', () => {
    const r = classify({ assertion: passing(), stepsCompleted: 3 });
    expect(r.verdict).toBe('pass');
    expect(r.reason).toMatch(/iOS/);
  });

  it('fail: the worker evaluated the assertion and the app answered no', () => {
    const r = classify({ assertion: failing(), stepsCompleted: 3 });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/ZZZQQQ-NOT-PRESENT|banner/);
  });

  it('fail: an action step could not be completed but the assertion still answered no', () => {
    const r = classify({
      assertion: failing(),
      failedAction: { outcome: outcome({ status: 'failed' }), label: 'Tap "Place order"' },
      stepsCompleted: 2,
    });
    expect(r.verdict).toBe('fail');
  });

  it('pass: an action step missed but the app got there anyway', () => {
    const r = classify({
      assertion: passing(),
      failedAction: { outcome: outcome({ status: 'failed' }), label: 'Tap "Place order"' },
      stepsCompleted: 2,
    });
    expect(r.verdict).toBe('pass');
  });

  it('inconclusive: the device, install or bundle load failed before the flow', () => {
    const r = classify({ infraReason: 'Could not install the app: Installation failed', stepsCompleted: 0 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toMatch(/Installation failed/);
  });

  it('inconclusive: the assertion never ran', () => {
    const r = classify({ failedAction: { outcome: outcome(), label: 'Open cart' }, stepsCompleted: 1 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toMatch(/Open cart/);
  });

  it('inconclusive: the assertion timed out', () => {
    const r = classify({ assertion: outcome({ timedOut: true }), stepsCompleted: 4 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toMatch(/timed out/);
  });

  it('inconclusive: the worker could not run the validation at all', () => {
    const r = classify({ assertion: outcome({ status: 'error', validationResult: false }), stepsCompleted: 4 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toMatch(/status "error"/);
  });

  it('inconclusive: a healthy envelope that carries no boolean verdict', () => {
    const r = classify({ assertion: outcome({ ok: true, code: 0, status: 'success' }), stepsCompleted: 4 });
    expect(r.verdict).toBe('inconclusive');
  });

  it('never returns fail on evidence the app did not produce', () => {
    const infraShapes = [
      outcome({ stderr: 'Error: no active session', workerResponded: false }),
      outcome({ spawnError: 'ENOENT', code: -1, workerResponded: false }),
      outcome({ timedOut: true }),
      parseStepOutcome(fail({ stderr: 'Error: backend device control request failed: context deadline exceeded' })),
    ];
    for (const assertion of infraShapes) {
      expect(classify({ assertion, stepsCompleted: 0 }).verdict).toBe('inconclusive');
    }
  });

  it('keeps the reason to one readable sentence', () => {
    const r = classify({ assertion: passing(), stepsCompleted: 1 });
    expect(r.reason.length).toBeLessThanOrEqual(241);
    expect(r.reason).not.toContain('\n');
  });
});
