/**
 * Finding the buildable thing, without running the build tool.
 *
 * `xcodebuild -list` and `gradlew projects` both answer these questions
 * authoritatively, and both cost 10-30 seconds on a cold project. Detection
 * runs on every adapter for every `init` and every run, so it reads the
 * filesystem instead: project files, scheme files, and settings scripts say
 * enough, and anything ambiguous is settled by config rather than by guessing
 * slowly.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type ProjectKind = 'workspace' | 'project' | 'swiftpm';

export interface XcodeProject {
  /** Directory holding the project, relative to the tree root ('' at the root). */
  dir: string;
  kind: ProjectKind;
  /** Basename of the .xcworkspace / .xcodeproj, or 'Package.swift'. */
  container: string;
  /** Shared schemes found on disk, in the order Xcode lists them. */
  schemes: string[];
  hasPodfile: boolean;
  /** True when this project sits under a JS project's ios/ directory. */
  nested: boolean;
}

export interface GradleProject {
  dir: string;
  /** Modules from settings.gradle, e.g. ['app', 'wear']. */
  modules: string[];
  hasWrapper: boolean;
  kotlin: boolean;
  nested: boolean;
}

/** Where a React Native or Expo app keeps its native projects. */
const NESTED_IOS_DIRS = ['ios', 'apple'];
const NESTED_ANDROID_DIRS = ['android'];

// ---------------------------------------------------------------------------
// Xcode
// ---------------------------------------------------------------------------

export async function detectXcodeProject(root: string): Promise<XcodeProject | undefined> {
  for (const [dir, nested] of candidateDirs(root, NESTED_IOS_DIRS)) {
    const found = await xcodeProjectIn(root, dir, nested);
    if (found) return found;
  }
  return undefined;
}

async function xcodeProjectIn(
  root: string,
  dir: string,
  nested: boolean,
): Promise<XcodeProject | undefined> {
  const abs = path.join(root, dir);
  const entries = await listDir(abs);
  if (!entries) return undefined;

  // A .xcworkspace wins: with CocoaPods, building the .xcodeproj alone fails.
  const workspace = entries.find((e) => e.endsWith('.xcworkspace'));
  const project = entries.find((e) => e.endsWith('.xcodeproj'));
  const container = workspace ?? project;

  if (!container) {
    if (entries.includes('Package.swift')) {
      return {
        dir,
        kind: 'swiftpm',
        container: 'Package.swift',
        schemes: [],
        hasPodfile: false,
        nested,
      };
    }
    return undefined;
  }

  // Schemes live in the .xcodeproj even when the workspace is what you build.
  const schemeHosts = [container, ...(workspace && project ? [project] : [])];
  const schemes: string[] = [];
  for (const host of schemeHosts) {
    for (const s of await sharedSchemes(path.join(abs, host))) {
      if (!schemes.includes(s)) schemes.push(s);
    }
  }

  return {
    dir,
    kind: workspace ? 'workspace' : 'project',
    container,
    schemes,
    hasPodfile: entries.includes('Podfile'),
    nested,
  };
}

async function sharedSchemes(containerPath: string): Promise<string[]> {
  const dir = path.join(containerPath, 'xcshareddata', 'xcschemes');
  const entries = (await listDir(dir)) ?? [];
  return entries.filter((e) => e.endsWith('.xcscheme')).map((e) => e.slice(0, -'.xcscheme'.length));
}

// ---------------------------------------------------------------------------
// Gradle
// ---------------------------------------------------------------------------

export async function detectGradleProject(root: string): Promise<GradleProject | undefined> {
  for (const [dir, nested] of candidateDirs(root, NESTED_ANDROID_DIRS)) {
    const found = await gradleProjectIn(root, dir, nested);
    if (found) return found;
  }
  return undefined;
}

async function gradleProjectIn(
  root: string,
  dir: string,
  nested: boolean,
): Promise<GradleProject | undefined> {
  const abs = path.join(root, dir);
  const entries = await listDir(abs);
  if (!entries) return undefined;

  const settings = entries.find((e) => e === 'settings.gradle' || e === 'settings.gradle.kts');
  if (!settings) return undefined;

  const source = (await readText(path.join(abs, settings))) ?? '';
  const modules = parseIncludedModules(source);
  const kotlin =
    settings.endsWith('.kts') ||
    (await hasKotlinPlugin(abs, modules.length > 0 ? modules : ['app']));

  return {
    dir,
    modules: modules.length > 0 ? modules : ['app'],
    hasWrapper: entries.includes('gradlew'),
    kotlin,
    nested,
  };
}

/**
 * `include ':app', ':wear'` and `include(":app")` both appear in the wild, and
 * a project may repeat the call. Nested paths keep their colons: `:features:x`
 * is one module, not two.
 */
export function parseIncludedModules(source: string): string[] {
  const out: string[] = [];
  const call = /\binclude(?:Build)?\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)?/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(source)) !== null) {
    if (m[0].startsWith('includeBuild')) continue;
    for (const raw of m[1]!.match(/['"][^'"]+['"]/g) ?? []) {
      const name = raw.slice(1, -1).replace(/^:/, '');
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

async function hasKotlinPlugin(dir: string, modules: string[]): Promise<boolean> {
  for (const module of modules) {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const text = await readText(path.join(dir, module.replace(/:/g, path.sep), name));
      if (text && /kotlin|org\.jetbrains\.kotlin/.test(text)) return true;
    }
  }
  return false;
}

/** `applicationId "com.example.app"` / `applicationId = "com.example.app"`. */
export function parseApplicationId(source: string): string | undefined {
  return /\bapplicationId\s*(?:=|\s)\s*["']([^"']+)["']/.exec(source)?.[1];
}

// ---------------------------------------------------------------------------

/** The tree root first, then the conventional subdirectories a JS app uses. */
function candidateDirs(root: string, nestedNames: string[]): Array<[string, boolean]> {
  void root;
  return [['', false], ...nestedNames.map((n): [string, boolean] => [n, true])];
}

async function listDir(dir: string): Promise<string[] | undefined> {
  try {
    return await readdir(dir);
  } catch {
    return undefined;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
