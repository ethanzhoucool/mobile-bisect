import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformsIn, RevylRemoteAdapter } from './remote-adapter.js';
import type { CliExecutor, CliResult } from './exec.js';
import { fail, ok } from './fixtures.testutil.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

let root: string;
let repo: string;
let worktree: string;

const CONFIG = [
  'project:',
  '    name: vault',
  'build:',
  '    system: Xcode',
  '    platforms:',
  '        ios:',
  '            command: xcodebuild -scheme Vault',
  '            output: build/*.app',
  '            app_id: 449ae04e-0000-0000-0000-000000000000',
  '',
].join('\n');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-remote-'));
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'wt');
  await mkdir(path.join(repo, '.revyl'), { recursive: true });
  await writeFile(path.join(repo, '.revyl', 'config.yaml'), CONFIG, 'utf8');
  await mkdir(worktree, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Records argv and replays the recorded `revyl build --remote` response. */
function fakeCli(result?: CliResult) {
  const calls: string[][] = [];
  const executor: CliExecutor = async (args) => {
    calls.push(args);
    return { ...(result ?? ok('build-remote')), argv: args };
  };
  return { executor, calls };
}

describe('RevylRemoteAdapter.detect', () => {
  it('accepts a project with a Revyl build config', async () => {
    const adapter = new RevylRemoteAdapter({ projectRoot: repo, executor: fakeCli().executor });
    const d = await adapter.detect(repo);

    expect(d.ok).toBe(true);
    expect(d.platforms).toEqual(['ios']);
    expect(d.summary).toContain('Revyl runners');
  });

  it('scores below every local adapter, so it is the fallback and not the default', async () => {
    const d = await new RevylRemoteAdapter({ projectRoot: repo }).detect(repo);
    // XcodeAdapter scores 0.8 standalone / 0.55 nested; Expo 0.95.
    expect(d.confidence).toBeLessThan(0.55);
  });

  it('explains how to enable it when there is no config', async () => {
    const bare = path.join(root, 'bare');
    await mkdir(bare, { recursive: true });

    const d = await new RevylRemoteAdapter({ projectRoot: bare }).detect(bare);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/revyl init/);
  });

  it('declines a config with no build platforms', async () => {
    const empty = path.join(root, 'empty');
    await mkdir(path.join(empty, '.revyl'), { recursive: true });
    await writeFile(path.join(empty, '.revyl', 'config.yaml'), 'project:\n    name: x\n', 'utf8');

    const d = await new RevylRemoteAdapter({ projectRoot: empty }).detect(empty);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/build\.platforms/);
  });
});

describe('RevylRemoteAdapter.prepare', () => {
  it('builds the candidate in the cloud and returns an installable build id', async () => {
    const { executor, calls } = fakeCli();
    const adapter = new RevylRemoteAdapter({ projectRoot: repo, executor });

    const candidate = await adapter.prepare(SHA, worktree, { platform: 'ios' });

    expect(candidate.kind).toBe('binary');
    expect(candidate.buildId).toBe('9df45d90-0000-0000-0000-000000000000');
    // Already registered with Revyl, so there is nothing left to upload.
    expect(candidate.appPath).toBeUndefined();

    const argv = calls[0]!;
    expect(argv.slice(0, 2)).toEqual(['-C', worktree]);
    expect(argv).toContain('--remote');
    expect(argv).toContain(SHA.slice(0, 7));
  });

  it('runs the build against the candidate worktree, never the user checkout', async () => {
    const { executor, calls } = fakeCli();
    await new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
      platform: 'ios',
    });
    expect(calls[0]![1]).toBe(worktree);
    expect(calls[0]![1]).not.toBe(repo);
  });

  it('seeds the build config into the worktree, since .revyl is usually untracked', async () => {
    let seenDuringBuild = false;
    const executor: CliExecutor = async (args) => {
      seenDuringBuild = await exists(path.join(worktree, '.revyl', 'config.yaml'));
      return { ...ok('build-remote'), argv: args };
    };

    await new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
      platform: 'ios',
    });

    expect(seenDuringBuild).toBe(true);
  });

  it('removes the seeded config afterwards, so the worktree diff stays honest', async () => {
    const { executor } = fakeCli();
    await new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
      platform: 'ios',
    });

    expect(await exists(path.join(worktree, '.revyl'))).toBe(false);
  });

  it('leaves a config the commit actually tracked alone', async () => {
    await mkdir(path.join(worktree, '.revyl'), { recursive: true });
    await writeFile(path.join(worktree, '.revyl', 'config.yaml'), CONFIG, 'utf8');
    const { executor } = fakeCli();

    await new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
      platform: 'ios',
    });

    expect(await exists(path.join(worktree, '.revyl', 'config.yaml'))).toBe(true);
  });

  it('does not rebuild a commit it already built this run', async () => {
    const { executor, calls } = fakeCli();
    const adapter = new RevylRemoteAdapter({ projectRoot: repo, executor });

    await adapter.prepare(SHA, worktree, { platform: 'ios' });
    const second = await adapter.prepare(SHA, worktree, { platform: 'ios' });

    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('builds each commit separately', async () => {
    const { executor, calls } = fakeCli();
    const adapter = new RevylRemoteAdapter({ projectRoot: repo, executor });

    await adapter.prepare(SHA, worktree, { platform: 'ios' });
    await adapter.prepare(OTHER, worktree, { platform: 'ios' });

    expect(calls).toHaveLength(2);
  });

  it('reports a compile failure with the runner output attached', async () => {
    const { executor } = fakeCli(
      fail({ stderr: "Vault/OrderView.swift:41:9: error: cannot find 'orderId' in scope" }),
    );

    await expect(
      new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
        platform: 'ios',
      }),
    ).rejects.toThrow(/cannot find 'orderId' in scope/);
  });

  it('distinguishes a runner problem from a bad commit in the message', async () => {
    const { executor } = fakeCli(fail({ stderr: 'Error: no build runner capacity available' }));

    await expect(
      new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
        platform: 'ios',
      }),
    ).rejects.toThrow(/runner problem rather than a bad commit/);
  });

  it('refuses to continue when the build returns no id', async () => {
    const { executor } = fakeCli({
      argv: [], code: 0, stdout: '{"status":"success"}', stderr: '', durationMs: 1, timedOut: false,
    });

    await expect(
      new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(SHA, worktree, {
        platform: 'ios',
      }),
    ).rejects.toThrow(/no build id/);
  });

  it('says so when the user checkout has no build config to seed from', async () => {
    const bare = path.join(root, 'nocfg');
    await mkdir(bare, { recursive: true });
    const { executor } = fakeCli();

    await expect(
      new RevylRemoteAdapter({ projectRoot: bare, executor }).prepare(SHA, worktree, {
        platform: 'ios',
      }),
    ).rejects.toThrow(/cannot be built remotely/);
  });
});

describe('platformsIn', () => {
  it('reads the platform keys out of a build config', () => {
    expect(platformsIn(CONFIG)).toEqual(['ios']);
  });

  it('reads both platforms', () => {
    const both = CONFIG.replace(
      '        ios:',
      '        android:\n            command: ./gradlew\n        ios:',
    );
    expect(platformsIn(both).sort()).toEqual(['android', 'ios']);
  });

  it('treats a build variant key as its platform', () => {
    expect(platformsIn(CONFIG.replace('        ios:', '        ios-dev:'))).toEqual(['ios']);
  });

  it('is empty when there is no platforms block', () => {
    expect(platformsIn('project:\n    name: x\n')).toEqual([]);
  });

  it('does not mistake a nested key for a platform', () => {
    expect(platformsIn(CONFIG)).not.toContain('command');
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('launching what it built', () => {
  it('carries the bundle id, since installing a build does not foreground it', async () => {
    const { executor } = fakeCli();
    const candidate = await new RevylRemoteAdapter({ projectRoot: repo, executor }).prepare(
      SHA,
      worktree,
      { platform: 'ios' },
    );

    // Without this the app is installed and the flow runs against the
    // springboard, failing for a reason unrelated to the commit.
    expect(candidate.bundleId).toBe('com.revyl.vault');
  });

  it('keeps the bundle id when the build is reused', async () => {
    const { executor } = fakeCli();
    const adapter = new RevylRemoteAdapter({ projectRoot: repo, executor });

    await adapter.prepare(SHA, worktree, { platform: 'ios' });
    const again = await adapter.prepare(SHA, worktree, { platform: 'ios' });

    expect(again.cached).toBe(true);
    expect(again.bundleId).toBe('com.revyl.vault');
  });
});
