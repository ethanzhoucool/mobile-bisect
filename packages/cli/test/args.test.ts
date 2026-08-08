import { describe, expect, it } from 'vitest';
import { helpText, parseArgs, type RunOptions } from '../src/args.js';
import { CliError } from '../src/errors.js';

function run(argv: string[]): RunOptions {
  return parseArgs(argv, '/tmp/project') as RunOptions;
}

function reject(argv: string[]): CliError {
  try {
    parseArgs(argv, '/tmp/project');
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected the arguments to be rejected');
}

describe('parseArgs', () => {
  it('parses the headline command', () => {
    const opts = run([
      'run',
      '--good',
      'v1.4.0',
      '--bad',
      'HEAD',
      '--flow',
      'flows/checkout.yaml',
      '--expect',
      'the order confirmation screen appears',
    ]);

    expect(opts).toMatchObject({
      command: 'run',
      good: 'v1.4.0',
      bad: 'HEAD',
      flow: 'flows/checkout.yaml',
      expect: 'the order confirmation screen appears',
      platform: 'ios',
      concurrency: 1,
      maxCandidates: 64,
      dryRun: false,
      ui: true,
    });
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(run(['run', '--good=v1', '--bad=HEAD', '--device-model=iPhone 15 Pro'])).toMatchObject({
      good: 'v1',
      bad: 'HEAD',
      deviceModel: 'iPhone 15 Pro',
    });
  });

  it('handles --no-<flag> negation', () => {
    expect(run(['run', '--good', 'a', '--bad', 'b', '--no-ui']).ui).toBe(false);
    expect(parseArgs(['report', '--no-open'], '/tmp')).toMatchObject({ open: false });
  });

  it('--json implies plain output', () => {
    const opts = run(['run', '--good', 'a', '--bad', 'b', '--json']);
    expect(opts.json).toBe(true);
    expect(opts.ui).toBe(false);
  });

  it('requires both boundaries', () => {
    expect(reject(['run', '--good', 'v1']).message).toContain('needs both `--good <ref>`');
    expect(reject(['run']).exitCode).toBe(2);
  });

  it('never accepts a credential on the command line', () => {
    for (const flag of ['--api-key', '--token', '--revyl-api-key', '--secret', '--password']) {
      const error = reject(['run', '--good', 'a', '--bad', 'b', flag, 'rvl_live_abc123']);
      expect(error.message).toContain('never accepts credentials');
      expect(error.hint).toContain('REVYL_API_KEY');
    }
  });

  it('suggests the nearest flag for a typo', () => {
    const error = reject(['run', '--good', 'a', '--bad', 'b', '--conccurency', '4']);
    expect(error.message).toContain('Unknown option `--conccurency`');
    expect(error.hint).toContain('--concurrency');
  });

  it('suggests the nearest command', () => {
    expect(reject(['reprot']).hint).toContain('expo-bisect report');
  });

  it('validates numeric ranges', () => {
    expect(reject(['run', '--good', 'a', '--bad', 'b', '--concurrency', '99']).message).toContain(
      'between 1 and 8',
    );
    expect(reject(['run', '--good', 'a', '--bad', 'b', '--concurrency', 'lots']).message).toContain(
      'whole number',
    );
    expect(run(['run', '--good', 'a', '--bad', 'b', '--timeout', '30']).timeoutMs).toBe(30_000);
  });

  it('validates the platform', () => {
    expect(reject(['run', '--good', 'a', '--bad', 'b', '--platform', 'web']).message).toContain(
      '`ios` or `android`',
    );
  });

  it('routes the other commands', () => {
    expect(parseArgs([], '/tmp')).toMatchObject({ command: 'help' });
    expect(parseArgs(['--version'], '/tmp')).toMatchObject({ command: 'version' });
    expect(parseArgs(['run', '--help'], '/tmp')).toMatchObject({ command: 'help', topic: 'run' });
    expect(parseArgs(['resume'], '/tmp')).toMatchObject({ command: 'resume', runId: undefined });
    expect(parseArgs(['resume', '20260807-x'], '/tmp')).toMatchObject({ runId: '20260807-x' });
    expect(parseArgs(['replay', 'f.jsonl'], '/tmp')).toMatchObject({
      command: 'replay',
      fixture: 'f.jsonl',
      speed: 1,
    });
    expect(reject(['replay']).message).toContain('needs a path');
  });

  it('honours --cwd everywhere', () => {
    expect(parseArgs(['init', '--cwd', '/elsewhere'], '/tmp')).toMatchObject({ cwd: '/elsewhere' });
    expect(parseArgs(['init'], '/tmp/project')).toMatchObject({ cwd: '/tmp/project' });
  });
});

describe('helpText', () => {
  it('documents every command and says where auth comes from', () => {
    const text = helpText();
    for (const command of ['init', 'run', 'resume', 'report', 'replay']) {
      expect(text).toContain(command);
    }
    expect(text).toContain('never accepts an API key as a flag');
    expect(text).toContain('--dry-run');
  });

  it('has a focused page per command', () => {
    expect(helpText('run')).toContain('expo-bisect run —');
    expect(helpText('init')).toContain('expo-bisect init —');
  });
});
