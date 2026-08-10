/**
 * The out-of-scope guard.
 *
 * v1 swaps JavaScript underneath a dev-client binary that was built once. If
 * the range contains a native change the swap is a lie: the JS would run
 * against the wrong native modules. Detection is a pure function so it can be
 * unit-tested without a repo; `detectNativeChangeFromGit` is the thin git shim.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NativeChangeInput {
  /** Paths from `git diff --name-only good..bad`, repo-relative. */
  changedFiles: string[];
  goodPackageJson?: unknown;
  badPackageJson?: unknown;
}

export interface NativeChangeReport {
  native: boolean;
  /** The subset of `changedFiles` that triggered the verdict. */
  changedPaths: string[];
  /** Dependency names whose native side changed. */
  changedNativeModules: string[];
  reasons: string[];
}

export class NativeChangeError extends Error {
  readonly changedPaths: string[];
  readonly changedNativeModules: string[];
  readonly goodRef: string;
  readonly badRef: string;
  readonly reasons: string[];

  constructor(report: NativeChangeReport, goodRef: string, badRef: string) {
    super(formatNativeChangeMessage(report, goodRef, badRef));
    this.name = 'NativeChangeError';
    this.changedPaths = [...report.changedPaths];
    this.changedNativeModules = [...report.changedNativeModules];
    this.reasons = [...report.reasons];
    this.goodRef = goodRef;
    this.badRef = badRef;
  }
}

export function formatNativeChangeMessage(
  report: NativeChangeReport,
  goodRef: string,
  badRef: string,
): string {
  const bullets = report.reasons.map((r) => `  - ${r}`).join('\n');
  return [
    `${goodRef}..${badRef} contains a native change, which the Expo adapter cannot`,
    'honestly bisect.',
    '',
    bullets || '  - (no detail recorded)',
    '',
    'The Expo adapter points an already-installed dev client at each candidate\'s JS.',
    'A native change (new/updated native module, a Podfile or Gradle edit, or a',
    'config-plugin change in app.json / app.config.*) needs a fresh binary, so',
    'swapping JS alone would test the wrong thing.',
    '',
    'Either narrow --good/--bad to a JS-only range, or build every candidate for real:',
    '',
    '  mobile-bisect run --framework xcode  --good <ref> --bad <ref>   # iOS',
    '  mobile-bisect run --framework gradle --good <ref> --bad <ref>   # Android',
    '',
    'That is minutes per candidate instead of seconds, but it is correct.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

/** `ios/` or `android/` at the repo root or under any workspace dir. */
const NATIVE_DIR_RE = /(^|\/)(ios|android)\//;

const NATIVE_BASENAMES = new Set([
  'Podfile',
  'Podfile.lock',
  'build.gradle',
  'build.gradle.kts',
  'gradle.properties',
  'settings.gradle',
  'settings.gradle.kts',
  'AndroidManifest.xml',
  'Info.plist',
  'app.json',
]);

const NATIVE_EXT_RE = /\.(podspec|entitlements)$/;
const XCODE_RE = /\.(xcodeproj|xcworkspace)(\/|$)/;
const APP_CONFIG_RE = /(^|\/)app\.config\.(js|cjs|mjs|ts|tsx|json)$/;

/** True for a path whose change cannot be picked up by swapping JS. */
export function isNativePath(file: string): boolean {
  return classifyNativePath(file) !== undefined;
}

/** The rule a path matched, or undefined when the path is JS-safe. */
export function classifyNativePath(file: string): string | undefined {
  const p = file.replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);

  if (NATIVE_DIR_RE.test(p)) return `native project directory: ${p}`;
  if (XCODE_RE.test(p)) return `Xcode project file: ${p}`;
  if (NATIVE_EXT_RE.test(base)) return `native build descriptor: ${p}`;
  if (base === 'app.json') return `Expo app config changed (config plugins force a rebuild): ${p}`;
  if (APP_CONFIG_RE.test(p)) return `Expo app config changed (config plugins force a rebuild): ${p}`;
  if (NATIVE_BASENAMES.has(base)) return `native build descriptor: ${p}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Dependency rules
// ---------------------------------------------------------------------------

/** Names that are native despite not matching the `expo-` / `react-native-` prefixes. */
export const CURATED_NATIVE_MODULES = new Set([
  'react-native',
  'expo',
  'expo-dev-client',
  'react-native-reanimated',
  'react-native-gesture-handler',
  'react-native-screens',
  'react-native-safe-area-context',
  'react-native-svg',
  'expo-router',
]);

/**
 * `expo-router` ships JS in recent SDKs, but its native peers move with majors,
 * so it is only flagged on a major bump — see `isNativeDependencyChange`.
 */
export const MAJOR_ONLY_NATIVE_MODULES = new Set(['expo-router']);

export function isNativeModuleName(name: string): boolean {
  if (CURATED_NATIVE_MODULES.has(name)) return true;
  if (name.startsWith('expo-')) return true;
  if (name.startsWith('react-native-')) return true;
  if (name.startsWith('@expo/')) return true;
  if (name.startsWith('@react-native-')) return true;
  return false;
}

/** Leading major from a semver range, or undefined when it isn't semver-ish. */
export function majorOf(range: string | undefined): number | undefined {
  if (typeof range !== 'string') return undefined;
  const m = /(\d+)\s*(?:\.|$)/.exec(range.replace(/^[\^~><=v\s]+/, ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function depsOf(pkg: unknown): Record<string, string> {
  if (!pkg || typeof pkg !== 'object') return {};
  const deps = (pkg as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectNativeChange(input: NativeChangeInput): NativeChangeReport {
  const changedPaths: string[] = [];
  const reasons: string[] = [];

  for (const file of input.changedFiles) {
    const reason = classifyNativePath(file);
    if (reason) {
      changedPaths.push(file);
      reasons.push(reason);
    }
  }

  const good = depsOf(input.goodPackageJson);
  const bad = depsOf(input.badPackageJson);
  const changedNativeModules: string[] = [];

  // devDependencies are deliberately ignored: they never reach the binary.
  for (const name of new Set([...Object.keys(good), ...Object.keys(bad)])) {
    const from = good[name];
    const to = bad[name];
    if (from === to) continue;
    if (!isNativeModuleName(name)) continue;

    if (MAJOR_ONLY_NATIVE_MODULES.has(name)) {
      const fromMajor = majorOf(from);
      const toMajor = majorOf(to);
      const bothParsed = fromMajor !== undefined && toMajor !== undefined;
      if (bothParsed && fromMajor === toMajor) continue;
      changedNativeModules.push(name);
      reasons.push(
        bothParsed
          ? `native module major bump: ${name} ${from} -> ${to}`
          : `native module changed: ${name} ${from ?? '(absent)'} -> ${to ?? '(removed)'}`,
      );
      continue;
    }

    changedNativeModules.push(name);
    if (from === undefined) reasons.push(`native module added: ${name}@${to}`);
    else if (to === undefined) reasons.push(`native module removed: ${name}@${from}`);
    else reasons.push(`native module version changed: ${name} ${from} -> ${to} (a rebuild is required even for a patch)`);
  }

  changedNativeModules.sort();
  return {
    native: changedPaths.length > 0 || changedNativeModules.length > 0,
    changedPaths,
    changedNativeModules,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Git shim
// ---------------------------------------------------------------------------

export interface GitNativeChangeOptions {
  /** package.json to compare, repo-relative. Default `package.json`. */
  packageJsonPath?: string;
}

/** Runs `git diff --name-only <good> <bad>` (execFile, no shell) and classifies it. */
export async function detectNativeChangeFromGit(
  repo: string,
  goodRef: string,
  badRef: string,
  opts: GitNativeChangeOptions = {},
): Promise<NativeChangeReport> {
  assertRefish(goodRef);
  assertRefish(badRef);
  const pkgPath = opts.packageJsonPath ?? 'package.json';

  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, 'diff', '--name-only', goodRef, badRef],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const changedFiles = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  const input: NativeChangeInput = { changedFiles };
  const goodPkg = await showJson(repo, goodRef, pkgPath);
  const badPkg = await showJson(repo, badRef, pkgPath);
  if (goodPkg !== undefined) input.goodPackageJson = goodPkg;
  if (badPkg !== undefined) input.badPackageJson = badPkg;
  return detectNativeChange(input);
}

async function showJson(repo: string, ref: string, file: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${file}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

function assertRefish(ref: string): void {
  if (!ref || ref.startsWith('-')) throw new Error(`refusing to use "${ref}" as a git ref`);
}
