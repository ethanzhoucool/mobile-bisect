/**
 * Turning a finished build into something a cloud device will accept.
 *
 * iOS is the fussy one. A simulator build produces a `.app` *directory*, which
 * has to be archived before upload, and the archiver matters: `ditto -c -k`
 * produces a zip that uploads fine and then fails to install, because it stores
 * the bundle differently than the installer expects. `zip -r` from inside the
 * products directory is the form that works.
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execBuild, type ExecFn } from './exec.js';

export interface FoundArtifact {
  /** Absolute path to the .app directory / .apk file. */
  path: string;
  name: string;
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

/**
 * `<derivedData>/Build/Products/<Configuration>-iphonesimulator/<Name>.app`.
 * Reading `xcodebuild -showBuildSettings` would be exact but costs another
 * xcodebuild launch per candidate, so the newest matching bundle wins instead.
 */
export async function findSimulatorApp(
  derivedDataPath: string,
  configuration: string,
  sdk = 'iphonesimulator',
): Promise<FoundArtifact | undefined> {
  const products = path.join(derivedDataPath, 'Build', 'Products');
  const dirs = (await listDir(products))
    .filter((d) => d.toLowerCase().endsWith(`-${sdk.toLowerCase()}`))
    // Prefer the requested configuration, but accept any if Xcode renamed it.
    .sort((a, b) => rank(b, configuration) - rank(a, configuration));

  for (const dir of dirs) {
    const abs = path.join(products, dir);
    const apps = (await listDir(abs)).filter((e) => e.endsWith('.app'));
    const newest = await newestOf(apps.map((a) => path.join(abs, a)));
    if (newest) return { path: newest, name: path.basename(newest) };
  }
  return undefined;
}

function rank(dirName: string, configuration: string): number {
  return dirName.toLowerCase().startsWith(`${configuration.toLowerCase()}-`) ? 1 : 0;
}

/**
 * Zips `<name>.app` to `outPath`. Runs from the bundle's parent so the archive
 * contains `<name>.app/...` and not the absolute path to it.
 */
export async function zipApp(
  appPath: string,
  outPath: string,
  opts: { exec?: ExecFn; timeoutMs?: number } = {},
): Promise<string> {
  const exec = opts.exec ?? execBuild;
  await mkdir(path.dirname(outPath), { recursive: true });
  await rm(outPath, { force: true });

  // Write beside the target and rename, so an interrupted zip never leaves a
  // truncated archive that a later run would happily treat as a cache hit.
  const tmp = `${outPath}.partial`;
  await rm(tmp, { force: true });
  const outcome = await exec('zip', ['-r', '-q', '-y', tmp, path.basename(appPath)], {
    cwd: path.dirname(appPath),
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  if (!outcome.ok) {
    await rm(tmp, { force: true });
    throw new Error(`zip failed for ${path.basename(appPath)}\n${outcome.output}`);
  }
  await rename(tmp, outPath);
  return outPath;
}

/** `CFBundleIdentifier` out of the built bundle. Undefined is survivable. */
export async function readBundleId(
  appPath: string,
  opts: { exec?: ExecFn } = {},
): Promise<string | undefined> {
  const exec = opts.exec ?? execBuild;
  const plist = path.join(appPath, 'Info.plist');
  const outcome = await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], {
    cwd: path.dirname(appPath),
    timeoutMs: 15_000,
  });
  if (!outcome.ok) return undefined;
  const id = outcome.output.trim().split('\n').pop()?.trim();
  return id && /^[A-Za-z0-9.\-_]+$/.test(id) ? id : undefined;
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

/**
 * `<module>/build/outputs/apk/<variant>/*.apk`. Universal APKs are preferred:
 * a split build emits several and only the universal one installs everywhere.
 */
export async function findApk(
  moduleDir: string,
  variant: string,
): Promise<FoundArtifact | undefined> {
  const dir = path.join(moduleDir, 'build', 'outputs', 'apk', variantPath(variant));
  const apks = (await listDir(dir)).filter((e) => e.endsWith('.apk'));
  if (apks.length === 0) return undefined;

  const universal = apks.filter((a) => /universal/i.test(a));
  const preferred = universal.length > 0 ? universal : apks.filter((a) => !/-(x86|armeabi|arm64|hdpi|xhdpi)/i.test(a));
  const pool = (preferred.length > 0 ? preferred : apks).map((a) => path.join(dir, a));
  const newest = await newestOf(pool);
  return newest ? { path: newest, name: path.basename(newest) } : undefined;
}

/** Gradle nests flavoured variants: `freeDebug` -> `free/debug`. */
export function variantPath(variant: string): string {
  const words = variant.split(/(?=[A-Z])/).filter(Boolean);
  if (words.length <= 1) return variant.toLowerCase();
  return path.join(...words.map(lowerFirst));
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------------------------------------------------------------------------

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function newestOf(paths: string[]): Promise<string | undefined> {
  let best: { p: string; mtime: number } | undefined;
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (!best || s.mtimeMs > best.mtime) best = { p, mtime: s.mtimeMs };
    } catch {
      // raced with a clean; skip
    }
  }
  return best?.p;
}
