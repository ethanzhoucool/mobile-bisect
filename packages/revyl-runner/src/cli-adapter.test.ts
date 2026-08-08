import { describe, expect, it } from 'vitest';
import type { FlowStep } from '@expo-bisect/core';
import * as cli from './cli-adapter.js';
import { UnsupportedStepError } from './errors.js';
import { fail, fixtureText, ok, recordedErrors } from './fixtures.testutil.js';

const T = { index: 2 };

describe('argv construction', () => {
  it('never opens a browser and always asks for JSON when starting a session', () => {
    expect(cli.deviceStartArgs({ platform: 'ios', deviceModel: 'iPhone 16', osVersion: 'iOS 18.5' })).toEqual([
      'device', 'start', '--json', '--open=false', '--platform', 'ios',
      '--device-model', 'iPhone 16', '--os-version', 'iOS 18.5',
    ]);
  });

  it('pins the build when one is given, otherwise falls back to the app id', () => {
    expect(cli.deviceStartArgs({ platform: 'ios', buildId: 'b1', appId: 'a1' })).toContain('--build-version-id');
    expect(cli.deviceStartArgs({ platform: 'ios', buildId: 'b1', appId: 'a1' })).not.toContain('--app-id');
    expect(cli.deviceStartArgs({ platform: 'ios', appId: 'a1' })).toContain('--app-id');
  });

  it('targets a session by index rather than mutating the active one', () => {
    expect(cli.deviceInfoArgs(T)).toEqual(['device', 'info', '--json', '-s', '2']);
    expect(cli.deviceInfoArgs(undefined)).toEqual(['device', 'info', '--json']);
    expect(cli.deviceInfoArgs({ index: -1 })).toEqual(['device', 'info', '--json']);
  });

  it('builds the deep-link navigate that swaps the JS bundle', () => {
    const url = 'exp+orbit://expo-development-client/?url=http%3A%2F%2F10.0.0.2%3A8093';
    expect(cli.deviceNavigateArgs(url, T)).toEqual([
      'device', 'navigate', '--json', '--url', url, '-s', '2',
    ]);
  });

  it('refuses an install with nothing to install', () => {
    expect(() => cli.deviceInstallArgs({}, T)).toThrow(UnsupportedStepError);
  });

  it('always passes --no-follow to device logs so the bisect cannot hang', () => {
    expect(cli.deviceLogsArgs(T)).toContain('--no-follow');
  });

  it('keeps shell metacharacters inert by passing an argv array', () => {
    const nasty = 'the total reads "$42.00"; rm -rf / && echo `pwned`';
    const argv = cli.deviceValidationArgs(nasty, T);
    expect(argv).toEqual(['device', 'validation', nasty, '--json', '-s', '2']);
    expect(argv.filter((a) => a === nasty)).toHaveLength(1);
  });
});

describe('stepArgs', () => {
  const step = (s: Partial<FlowStep>): FlowStep => ({ label: 'Step', ...s }) as FlowStep;

  it('maps the Revyl-native block vocabulary', () => {
    expect(cli.stepArgs(step({ type: 'instructions', step_description: 'Tap Place order' }), T)).toEqual({
      argv: ['device', 'instruction', 'Tap Place order', '--json', '-s', '2'],
      kind: 'action',
    });
    expect(cli.stepArgs(step({ type: 'validation', step_description: 'Order placed' }), T).kind).toBe('assertion');
    expect(
      cli.stepArgs(step({ type: 'extraction', step_description: 'The order id', variable_name: 'order-id' }), T).argv,
    ).toEqual(['device', 'extract', 'The order id', '--json', '--variable-name', 'order-id', '-s', '2']);
  });

  it('defaults to an instruction and falls back to the label for the description', () => {
    expect(cli.stepArgs(step({ label: 'Open the cart' }), undefined).argv).toEqual([
      'device', 'instruction', 'Open the cart', '--json',
    ]);
  });

  it('converts a YAML wait in seconds to the CLI flag in milliseconds', () => {
    expect(cli.stepArgs(step({ type: 'manual', step_type: 'wait', step_description: '2.5' }), undefined).argv).toEqual([
      'device', 'wait', '--json', '--duration-ms', '2500',
    ]);
  });

  it('splits a "lat,lon" description into the two flags the CLI wants', () => {
    expect(
      cli.stepArgs(step({ type: 'manual', step_type: 'set_location', step_description: '37.7749,-122.4194' }), undefined)
        .argv,
    ).toEqual(['device', 'set-location', '--json', '--lat', '37.7749', '--lon', '-122.4194']);
  });

  it('drives low-level verbs by target or by coordinates', () => {
    expect(cli.stepArgs(step({ type: 'manual', step_type: 'tap', target: 'Sign in' }), undefined).argv).toEqual([
      'device', 'tap', '--json', '--target', 'Sign in',
    ]);
    expect(cli.stepArgs(step({ type: 'manual', step_type: 'tap', x: 10, y: 20 }), undefined).argv).toEqual([
      'device', 'tap', '--json', '--x', '10', '--y', '20',
    ]);
    expect(
      cli.stepArgs(step({ type: 'manual', step_type: 'type', target: 'Email', text: 'a@b.co' }), undefined).argv,
    ).toEqual(['device', 'type', '--json', '--text', 'a@b.co', '--target', 'Email']);
    expect(
      cli.stepArgs(step({ type: 'manual', step_type: 'swipe', target: 'List', direction: 'DOWN' }), undefined).argv,
    ).toEqual(['device', 'swipe', '--json', '--direction', 'down', '--target', 'List']);
  });

  it('names the culprit step when it cannot be expressed', () => {
    expect(() => cli.stepArgs(step({ label: 'Loop', type: 'while', condition: 'more items' }), T)).toThrow(
      /Loop.*not supported/s,
    );
    expect(() => cli.stepArgs(step({ label: 'Odd', type: 'manual', step_type: 'teleport' }), T)).toThrow(
      /unsupported manual step_type "teleport"/,
    );
    expect(() => cli.stepArgs(step({ label: 'Tapper', type: 'manual', step_type: 'tap' }), T)).toThrow(
      /needs a target or x\/y/,
    );
  });
});

describe('parsing recorded CLI output', () => {
  it('reads auth status', () => {
    const status = cli.parseAuthStatus(ok('auth-status'));
    expect(status).toMatchObject({ ok: true, org: 'Example Org', email: 'dev@example.com' });
    expect(status.message).toContain('Example Org');
  });

  it('reports not-authenticated without leaking why', () => {
    const res = fail({ stderr: 'Error: REVYL_API_KEY not found' });
    expect(cli.parseAuthStatus(res).ok).toBe(false);
  });

  it('reads the session envelope from device start', () => {
    expect(cli.parseSessionInfo(ok('device-start'))).toEqual({
      index: 0,
      sessionId: '11111111-1111-4111-8111-111111111111',
      workflowRunId: '22222222-2222-4222-8222-222222222222',
      viewerUrl: 'https://app.revyl.ai/sessions/11111111-1111-4111-8111-111111111111',
      platform: 'ios',
      screenWidth: 393,
      screenHeight: 852,
    });
  });

  it('reads the session list, which is what index lookup depends on', () => {
    const list = cli.parseSessionList(ok('device-list'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ index: 0, sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(cli.parseSessionList(ok('device-start'))).toEqual([]); // object, not array
  });

  it('separates worker health from the app answer on a passing validation', () => {
    const out = cli.parseStepOutcome(ok('device-validation-pass'));
    expect(out).toMatchObject({ ok: true, workerResponded: true, success: true, status: 'success', validationResult: true });
    expect(out.reasoning).toMatch(/iOS/);
    expect(out.imageBase64).toBeTruthy();
  });

  it('reads a legitimately failing validation: exit 1, worker healthy, answer false', () => {
    const res = { ...ok('device-validation-fail'), code: 1, stderr: 'Error: validation failed' };
    const out = cli.parseStepOutcome(res);
    expect(out).toMatchObject({ ok: false, workerResponded: true, success: false, status: 'success', validationResult: false });
    expect(out.reasoning).toMatch(/ZZZQQQ-NOT-PRESENT/);
  });

  it('reads an instruction step', () => {
    const out = cli.parseStepOutcome(ok('device-instruction'));
    expect(out).toMatchObject({ ok: true, status: 'success', validationResult: null });
    expect(out.statusReason).toMatch(/App Library/);
    expect(out.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('handles the flatter envelope low-level verbs return', () => {
    // Recorded quirk: `device tap --target "<nonexistent>"` still reports
    // success and taps a guessed coordinate. This is exactly why the final
    // assertion, not step exit codes, decides the verdict.
    const out = cli.parseStepOutcome(ok('device-tap-miss'));
    expect(out).toMatchObject({ ok: true, workerResponded: true, success: true });
    expect(out.status).toBeUndefined();
    expect(out.validationResult).toBeUndefined();
  });

  it('survives an error path where the CLI writes nothing to stdout', () => {
    const recorded = recordedErrors()['device-install-bad']!;
    const out = cli.parseStepOutcome(fail({ stderr: recorded.stderr }));
    expect(out).toMatchObject({ ok: false, workerResponded: false, code: 1 });
    expect(out.stderr).toBe('Error: Installation failed');
  });

  it('harvests presigned screenshot URLs and device identity from the session report', () => {
    const report = cli.parseSessionReport(ok('device-report'));
    expect(report?.deviceModel).toBe('iPhone 16');
    expect(report?.osVersion).toBe('iOS 18.5');
    expect(report?.reportUrl).toContain('app.revyl.ai/sessions/report');
    expect(report?.screenshotUrls.length).toBeGreaterThan(0);
    for (const u of report!.screenshotUrls) expect(u).toMatch(/^https:\/\//);
  });

  it('finds an artifact URL however the CLI chose to print it', () => {
    expect(cli.parseArtifactUrl(fail({ code: 0, stdout: '"https://s3/x.gz"', stderr: '' }))).toBe('https://s3/x.gz');
    expect(cli.parseArtifactUrl(fail({ code: 0, stdout: '{"url":"https://s3/y.gz"}', stderr: '' }))).toBe('https://s3/y.gz');
    expect(cli.parseArtifactUrl(fail({ code: 0, stdout: 'Artifact: https://s3/z.gz\n', stderr: '' }))).toBe('https://s3/z.gz');
    expect(cli.parseArtifactUrl(fail({ code: 0, stdout: 'nothing here', stderr: '' }))).toBeUndefined();
  });

  it('recovers JSON that the CLI prefixed with progress chatter', () => {
    const res = fail({ code: 0, stderr: '', stdout: `Starting…\n${fixtureText('device-start')}` });
    expect(cli.parseSessionInfo(res)?.index).toBe(0);
  });
});
