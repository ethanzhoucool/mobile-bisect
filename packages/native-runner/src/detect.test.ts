import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectGradleProject,
  detectXcodeProject,
  parseApplicationId,
  parseIncludedModules,
} from './detect.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-detect-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function touch(rel: string, body = ''): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

async function scheme(container: string, name: string): Promise<void> {
  await touch(path.join(container, 'xcshareddata', 'xcschemes', `${name}.xcscheme`), '<Scheme/>');
}

describe('detectXcodeProject', () => {
  it('finds a plain .xcodeproj at the root', async () => {
    await touch('Orbit.xcodeproj/project.pbxproj');
    await scheme('Orbit.xcodeproj', 'Orbit');

    const found = await detectXcodeProject(root);
    expect(found).toMatchObject({ dir: '', kind: 'project', container: 'Orbit.xcodeproj' });
    expect(found?.schemes).toEqual(['Orbit']);
    expect(found?.nested).toBe(false);
  });

  it('prefers the workspace, because a CocoaPods project cannot be built alone', async () => {
    await touch('Orbit.xcodeproj/project.pbxproj');
    await touch('Orbit.xcworkspace/contents.xcworkspacedata');
    await touch('Podfile', "platform :ios, '16.0'");
    await scheme('Orbit.xcodeproj', 'Orbit');

    const found = await detectXcodeProject(root);
    expect(found?.kind).toBe('workspace');
    expect(found?.container).toBe('Orbit.xcworkspace');
    expect(found?.hasPodfile).toBe(true);
    // Schemes live in the .xcodeproj even when the workspace is what you build.
    expect(found?.schemes).toEqual(['Orbit']);
  });

  it('finds a React Native project under ios/ and marks it nested', async () => {
    await touch('package.json', '{"name":"app"}');
    await touch('ios/Orbit.xcworkspace/contents.xcworkspacedata');
    await touch('ios/Orbit.xcodeproj/project.pbxproj');
    await scheme('ios/Orbit.xcodeproj', 'Orbit');

    const found = await detectXcodeProject(root);
    expect(found?.dir).toBe('ios');
    expect(found?.nested).toBe(true);
  });

  it('reports a bare Swift package rather than pretending it is an app', async () => {
    await touch('Package.swift', '// swift-tools-version:5.9');

    const found = await detectXcodeProject(root);
    expect(found?.kind).toBe('swiftpm');
    expect(found?.schemes).toEqual([]);
  });

  it('collects every shared scheme so an ambiguous project can say so', async () => {
    await touch('Orbit.xcodeproj/project.pbxproj');
    await scheme('Orbit.xcodeproj', 'Orbit');
    await scheme('Orbit.xcodeproj', 'OrbitStaging');

    const found = await detectXcodeProject(root);
    expect(found?.schemes.sort()).toEqual(['Orbit', 'OrbitStaging']);
  });

  it('returns undefined for a directory with no Xcode project', async () => {
    await touch('README.md', '# nothing here');
    expect(await detectXcodeProject(root)).toBeUndefined();
  });
});

describe('detectGradleProject', () => {
  it('reads modules out of settings.gradle', async () => {
    await touch('settings.gradle', "include ':app', ':wear'\nrootProject.name = 'orbit'");
    await touch('gradlew', '#!/bin/sh');

    const found = await detectGradleProject(root);
    expect(found?.modules).toEqual(['app', 'wear']);
    expect(found?.hasWrapper).toBe(true);
    expect(found?.nested).toBe(false);
  });

  it('treats a .kts settings file as Kotlin', async () => {
    await touch('settings.gradle.kts', 'include(":app")');

    const found = await detectGradleProject(root);
    expect(found?.kotlin).toBe(true);
    expect(found?.modules).toEqual(['app']);
  });

  it('detects Kotlin from the module build script', async () => {
    await touch('settings.gradle', "include ':app'");
    await touch('app/build.gradle', "apply plugin: 'org.jetbrains.kotlin.android'");

    const found = await detectGradleProject(root);
    expect(found?.kotlin).toBe(true);
  });

  it('finds a React Native project under android/ and marks it nested', async () => {
    await touch('package.json', '{"name":"app"}');
    await touch('android/settings.gradle', "include ':app'");
    await touch('android/gradlew', '#!/bin/sh');

    const found = await detectGradleProject(root);
    expect(found?.dir).toBe('android');
    expect(found?.nested).toBe(true);
  });

  it('falls back to :app when settings.gradle includes nothing', async () => {
    await touch('settings.gradle', "rootProject.name = 'orbit'");

    const found = await detectGradleProject(root);
    expect(found?.modules).toEqual(['app']);
  });

  it('returns undefined without a settings script', async () => {
    await touch('build.gradle', 'plugins {}');
    expect(await detectGradleProject(root)).toBeUndefined();
  });
});

describe('parseIncludedModules', () => {
  it('handles both call styles and repeated calls', () => {
    const source = ["include ':app', ':wear'", 'include(":features:login")'].join('\n');
    expect(parseIncludedModules(source)).toEqual(['app', 'wear', 'features:login']);
  });

  it('ignores includeBuild, which is a composite build and not a module', () => {
    expect(parseIncludedModules('includeBuild("../shared")\ninclude(":app")')).toEqual(['app']);
  });

  it('deduplicates', () => {
    expect(parseIncludedModules("include ':app'\ninclude ':app'")).toEqual(['app']);
  });
});

describe('parseApplicationId', () => {
  it('reads Groovy and Kotlin DSL forms', () => {
    expect(parseApplicationId('applicationId "com.orbit.store"')).toBe('com.orbit.store');
    expect(parseApplicationId('applicationId = "com.orbit.store"')).toBe('com.orbit.store');
  });

  it('is undefined when there is none', () => {
    expect(parseApplicationId('android { compileSdk 34 }')).toBeUndefined();
  });
});
