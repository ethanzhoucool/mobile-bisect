/**
 * Ctrl-C during a native build has to stop the build.
 *
 * Builds run in their own process group, so the SIGINT a terminal sends to the
 * CLI's group never reaches them. Unless the CLI passes its abort signal to the
 * adapter, the compiler keeps running after the CLI has exited, writing into a
 * worktree that was just deleted.
 *
 * The toolchain here is fake on both sides: `gradlew` is a script that records
 * its pid and sleeps, and `revyl` is a script that answers the auth check and
 * nothing else, so no compiler is spawned and no network is touched.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, runCli, tempDir } from './helpers.js';

const AUTH_OK = JSON.stringify({ authenticated: true, expired: false, email: 'dev@example.com' });

async function fakeRevylCli(): Promise<string> {
  const dir = await tempDir('mobile-bisect-fake-revyl-');
  const cli = path.join(dir, 'revyl');
  await writeFile(
    cli,
    [
      '#!/bin/sh',
      'if [ "$1 $2 $3" = "auth status --json" ]; then',
      `  echo '${AUTH_OK}'`,
      '  exit 0',
      'fi',
      'echo "fake revyl: unexpected call: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(cli, 0o755);
  return cli;
}

/** An Android project whose wrapper never finishes a build, in every commit. */
async function gradleRepo(): Promise<string> {
  const dir = await tempDir();
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Test Bot']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await mkdir(path.join(dir, 'app'), { recursive: true });
  await mkdir(path.join(dir, 'flows'), { recursive: true });
  await writeFile(path.join(dir, 'settings.gradle'), "include ':app'\n");
  await writeFile(path.join(dir, 'app', 'build.gradle'), "plugins { id 'com.android.application' }\n");
  const wrapper = path.join(dir, 'gradlew');
  await writeFile(wrapper, ['#!/bin/sh', 'echo $$ > "$MB_TEST_BUILD_PID"', 'exec sleep 60', ''].join('\n'));
  await chmod(wrapper, 0o755);
  // No appId, so nothing asks Revyl to resolve an app before the build.
  await writeFile(
    path.join(dir, 'flows', 'android.yaml'),
    [
      'name: android-flow',
      'expect: the home screen appears',
      'steps:',
      '  - label: Check the home screen',
      '    type: validation',
      '    step_description: the home screen is showing',
      '',
    ].join('\n'),
  );
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'Release v1.0']);
  await git(dir, ['tag', 'v1.0']);
  for (let i = 1; i < 6; i++) {
    await writeFile(path.join(dir, 'app', 'version.txt'), `${i}\n`);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-qm', `commit ${i}`]);
  }
  return dir;
}

/** Running, and not a zombie waiting to be reaped by whoever inherited it. */
function isAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  const stat = (res.stdout ?? '').trim();
  return stat.length > 0 && !stat.startsWith('Z');
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

describe('interrupting a native build', () => {
  it.skipIf(process.platform === 'win32')(
    'stops the build process instead of leaving it running',
    async () => {
      const dir = await gradleRepo();
      const pidFile = path.join(await tempDir('mobile-bisect-build-pid-'), 'pid');
      let buildPid: number | undefined;
      let watching = false;

      const result = await runCli(
        [
          'run',
          '--good',
          'v1.0',
          '--bad',
          'HEAD',
          '--flow',
          'flows/android.yaml',
          '--framework',
          'gradle',
          '--platform',
          'android',
          '--no-prebuilt',
          '--no-ui',
          '--port',
          '0',
        ],
        {
          cwd: dir,
          env: { REVYL_CLI: await fakeRevylCli(), MB_TEST_BUILD_PID: pidFile },
          onStdout: (chunk, child) => {
            // One SIGINT: a second one is the hard-exit path, not the cleanup.
            if (watching || !/gradlew/.test(chunk)) return;
            watching = true;
            void waitFor(async () => {
              const text = await readFile(pidFile, 'utf8').catch(() => '');
              return text.trim() ? Number(text.trim()) : undefined;
            }, 10_000).then((pid) => {
              buildPid = pid;
              child.kill('SIGINT');
            });
          },
          timeoutMs: 60_000,
        },
      );

      try {
        expect(buildPid, `the build never started:\n${result.stdout}\n${result.stderr}`).toBeTypeOf('number');
        expect(result.code).toBe(130);
        expect(result.stdout).toContain('interrupted');

        // SIGTERM is sent to the build's process group on abort; give it a beat.
        const stillRunning = await waitFor(async () => (isAlive(buildPid!) ? undefined : false), 5_000);
        expect(stillRunning, `build ${buildPid} outlived the CLI`).toBe(false);
      } finally {
        if (buildPid !== undefined && isAlive(buildPid)) process.kill(buildPid, 'SIGKILL');
      }
    },
    90_000,
  );
});
