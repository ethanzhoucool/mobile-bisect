/**
 * Is this worktree something a dev client can load?
 *
 * Never throws: the bisector calls this per candidate and a malformed
 * package.json at one commit is a finding, not a crash.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ExpoProjectInfo {
  ok: boolean;
  sdkVersion?: string;
  usesRouter?: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
}

export const APP_CONFIG_FILES = [
  'app.json',
  'app.config.ts',
  'app.config.js',
  'app.config.mjs',
  'app.config.cjs',
];

export async function detectExpoProject(dir: string): Promise<ExpoProjectInfo> {
  const pkgPath = path.join(dir, 'package.json');

  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch {
    return { ok: false, reason: `no package.json in ${dir}, this is not a JavaScript project` };
  }

  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `${pkgPath} is not a JSON object` };
    }
    pkg = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `${pkgPath} is not valid JSON: ${describe(err)}` };
  }

  const deps = record(pkg.dependencies);
  const devDeps = record(pkg.devDependencies);
  const expoRange = deps.expo ?? devDeps.expo;

  if (!expoRange) {
    if (deps['react-native'] ?? devDeps['react-native']) {
      return {
        ok: false,
        reason:
          `${dir} is a bare React Native app (react-native without expo). mobile-bisect drives an ` +
          'Expo dev client, so the project needs the expo package installed.',
      };
    }
    return { ok: false, reason: `${dir} has no "expo" dependency, not an Expo project` };
  }

  const info: ExpoProjectInfo = { ok: true, usesRouter: Boolean(deps['expo-router'] ?? devDeps['expo-router']) };
  const sdkVersion = parseSdkVersion(expoRange);
  if (sdkVersion) info.sdkVersion = sdkVersion;
  return info;
}

/** `~52.0.11` -> `52.0.11`. Returns undefined for `*`, `latest`, git urls, etc. */
export function parseSdkVersion(range: string): string | undefined {
  const m = /^\s*[\^~><=v\s]*(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/.exec(range);
  return m ? m[1] : undefined;
}

/** First app config file present in `dir`, if any. */
export async function findAppConfigFile(dir: string): Promise<string | undefined> {
  for (const name of APP_CONFIG_FILES) {
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Static read of app.json only. `app.config.js/ts` needs evaluation, which we
 * refuse to do here, `expo config --json` is the caller's escape hatch.
 */
export async function readAppJson(dir: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(path.join(dir, 'app.json'), 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
