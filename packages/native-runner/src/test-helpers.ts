/**
 * A recording stand-in for `execBuild`.
 *
 * Nothing in this suite may spawn xcodebuild or gradlew: they need toolchains
 * CI does not have, and a passing test that took four minutes would never be
 * run. The adapters take their executor as an option for exactly this reason.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { variantPath } from './artifact.js';
import type { ExecFn, ExecOptions, ExecOutcome } from './exec.js';

export interface RecordedCall {
  command: string;
  args: string[];
  cwd: string;
}

/** Placeholder bytes for a stubbed build artifact. */
export const ZIP_MAGIC = 'stub-artifact';

export interface StubExecOptions {
  /** Commands that should fail, by name. */
  fail?: Record<string, { code?: number; output?: string }>;
  /** Runs before the outcome is returned, create the artifact the adapter expects. */
  onCall?: (call: RecordedCall) => Promise<void> | void;
}

export function stubExec(opts: StubExecOptions = {}): ExecFn & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (command: string, args: string[], o: ExecOptions): Promise<ExecOutcome> => {
    const call: RecordedCall = { command, args: [...args], cwd: o.cwd };
    calls.push(call);
    await opts.onCall?.(call);

    const failure = opts.fail?.[path.basename(command)];
    const code = failure ? (failure.code ?? 65) : 0;
    let output = failure?.output ?? '';
    if (!failure) output = (await emulate(call)) ?? output;
    if (output) for (const line of output.split('\n')) o.onLine?.(line);

    return {
      command,
      args: [...args],
      code,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      output,
      ok: code === 0,
    };
  };
  return Object.assign(fn, { calls });
}

/**
 * `zip` and `plutil` are real tools the adapter depends on the *behaviour* of,
 * not just the invocation of: without an archive on disk the next step fails,
 * and without a bundle id the launch path is untested. Both are cheap to fake
 * faithfully, unlike the compilers.
 */
async function emulate(call: RecordedCall): Promise<string | undefined> {
  const tool = path.basename(call.command);

  if (tool === 'zip') {
    const target = call.args.find((a) => a.endsWith('.zip') || a.endsWith('.partial'));
    if (!target) return undefined;
    const abs = path.isAbsolute(target) ? target : path.join(call.cwd, target);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ZIP_MAGIC, 'utf8');
    return undefined;
  }

  if (tool === 'plutil') {
    const plist = call.args[call.args.length - 1]!;
    try {
      const xml = await readFile(plist, 'utf8');
      const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Writes the `.app` bundle xcodebuild would have produced. */
export async function fakeSimulatorApp(
  derivedDataPath: string,
  configuration: string,
  appName: string,
  bundleId = 'com.orbit.store',
): Promise<string> {
  const dir = path.join(derivedDataPath, 'Build', 'Products', `${configuration}-iphonesimulator`);
  const app = path.join(dir, `${appName}.app`);
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, 'Info.plist'), plist(bundleId), 'utf8');
  await writeFile(path.join(app, appName), '#!/bin/sh\n', 'utf8');
  return app;
}

/** Writes the `.apk` Gradle would have produced, in Gradle's own nesting. */
export async function fakeApk(
  moduleDir: string,
  variant: string,
  name = 'app-debug.apk',
): Promise<string> {
  const dir = path.join(moduleDir, 'build', 'outputs', 'apk', variantPath(variant));
  await mkdir(dir, { recursive: true });
  const apk = path.join(dir, name);
  await writeFile(apk, ZIP_MAGIC, 'utf8');
  return apk;
}

function plist(bundleId: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key>',
    `<string>${bundleId}</string>`,
    '</dict></plist>',
    '',
  ].join('\n');
}
