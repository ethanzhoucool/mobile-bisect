import { describe, expect, it } from 'vitest';

import {
  NativeChangeError,
  classifyNativePath,
  detectNativeChange,
  isNativeModuleName,
  isNativePath,
  majorOf,
} from './native-change.js';

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) => ({
  name: 'app',
  dependencies: deps,
  devDependencies: dev,
});

interface Case {
  name: string;
  files?: string[];
  good?: Record<string, string>;
  bad?: Record<string, string>;
  goodDev?: Record<string, string>;
  badDev?: Record<string, string>;
  native: boolean;
  modules?: string[];
}

const CASES: Case[] = [
  {
    name: 'pure-JS source change',
    files: ['app/(tabs)/index.tsx', 'src/lib/cart.ts'],
    native: false,
  },
  {
    name: 'pure-JS dependency bump',
    good: { expo: '~52.0.0', zod: '^3.22.0', 'date-fns': '^3.6.0' },
    bad: { expo: '~52.0.0', zod: '^3.23.8', 'date-fns': '^4.0.0' },
    native: false,
  },
  {
    name: 'ios/Podfile touched',
    files: ['ios/Podfile'],
    native: true,
  },
  {
    name: 'ios/Podfile.lock touched',
    files: ['ios/Podfile.lock'],
    native: true,
  },
  {
    name: 'react-native-reanimated minor bump',
    good: { expo: '~52.0.0', 'react-native-reanimated': '~3.16.1' },
    bad: { expo: '~52.0.0', 'react-native-reanimated': '~3.17.0' },
    native: true,
    modules: ['react-native-reanimated'],
  },
  {
    name: 'react-native-svg patch bump still needs a rebuild',
    good: { 'react-native-svg': '15.8.0' },
    bad: { 'react-native-svg': '15.8.1' },
    native: true,
    modules: ['react-native-svg'],
  },
  {
    name: 'devDependency-only bump',
    goodDev: { typescript: '^5.6.3', 'react-native-svg-transformer': '^1.3.0' },
    badDev: { typescript: '^5.7.2', 'react-native-svg-transformer': '^1.5.0' },
    native: false,
  },
  {
    name: 'app.config.ts touched',
    files: ['app.config.ts'],
    native: true,
  },
  {
    name: 'app.json touched',
    files: ['app.json'],
    native: true,
  },
  {
    name: 'monorepo android sources',
    files: ['apps/mobile/android/app/src/main/java/com/app/MainActivity.kt'],
    native: true,
  },
  {
    name: 'monorepo ios sources',
    files: ['apps/mobile/ios/App/AppDelegate.mm'],
    native: true,
  },
  {
    name: 'expo-router patch bump is JS-only',
    good: { 'expo-router': '~3.5.14' },
    bad: { 'expo-router': '~3.5.23' },
    native: false,
  },
  {
    name: 'expo-router major bump moves its native peers',
    good: { 'expo-router': '~3.5.14' },
    bad: { 'expo-router': '~4.0.9' },
    native: true,
    modules: ['expo-router'],
  },
  {
    name: 'new native module added',
    good: { expo: '~52.0.0' },
    bad: { expo: '~52.0.0', 'expo-camera': '~16.0.7' },
    native: true,
    modules: ['expo-camera'],
  },
  {
    name: 'native module removed',
    good: { expo: '~52.0.0', '@react-native-async-storage/async-storage': '1.23.1' },
    bad: { expo: '~52.0.0' },
    native: true,
    modules: ['@react-native-async-storage/async-storage'],
  },
  {
    name: 'expo SDK bump',
    good: { expo: '~51.0.0' },
    bad: { expo: '~52.0.0' },
    native: true,
    modules: ['expo'],
  },
  {
    name: 'paths that merely mention ios/android',
    files: ['src/screens/ios-tips.ts', 'components/AndroidBanner.tsx', 'docs/android.md'],
    native: false,
  },
];

describe('detectNativeChange', () => {
  for (const c of CASES) {
    it(`${c.native ? 'flags' : 'allows'}: ${c.name}`, () => {
      const report = detectNativeChange({
        changedFiles: c.files ?? [],
        goodPackageJson: pkg(c.good ?? {}, c.goodDev ?? {}),
        badPackageJson: pkg(c.bad ?? c.good ?? {}, c.badDev ?? c.goodDev ?? {}),
      });
      expect(report.native, JSON.stringify(report.reasons)).toBe(c.native);
      if (c.modules) expect(report.changedNativeModules).toEqual(c.modules);
      if (!c.native) {
        expect(report.changedPaths).toEqual([]);
        expect(report.changedNativeModules).toEqual([]);
      }
    });
  }

  it('reports only the offending paths, not the whole diff', () => {
    const report = detectNativeChange({
      changedFiles: ['src/App.tsx', 'ios/Podfile', 'README.md', 'android/build.gradle'],
    });
    expect(report.changedPaths).toEqual(['ios/Podfile', 'android/build.gradle']);
    expect(report.reasons).toHaveLength(2);
  });

  it('tolerates missing package.json on either side', () => {
    const report = detectNativeChange({ changedFiles: ['src/App.tsx'] });
    expect(report.native).toBe(false);
  });

  it('flags an unparseable expo-router range rather than guessing', () => {
    const report = detectNativeChange({
      changedFiles: [],
      goodPackageJson: pkg({ 'expo-router': '~3.5.14' }),
      badPackageJson: pkg({ 'expo-router': 'github:expo/router#main' }),
    });
    expect(report.native).toBe(true);
    expect(report.changedNativeModules).toEqual(['expo-router']);
  });
});

describe('path classification', () => {
  const native = [
    'ios/Podfile',
    'ios/App.xcodeproj/project.pbxproj',
    'ios/App/Info.plist',
    'ios/App/App.entitlements',
    'android/app/build.gradle',
    'android/gradle.properties',
    'android/settings.gradle',
    'android/app/src/main/AndroidManifest.xml',
    'modules/my-module/expo-module.podspec',
    'apps/mobile/ios/Podfile.lock',
    'app.json',
    'app.config.js',
    'app.config.ts',
  ];
  const safe = ['src/App.tsx', 'app/index.tsx', 'package.json', 'README.md', 'src/ios.ts', 'lib/android.ts'];

  it.each(native)('%s is native', (p) => {
    expect(isNativePath(p)).toBe(true);
    expect(classifyNativePath(p)).toBeTypeOf('string');
  });

  it.each(safe)('%s is JS-safe', (p) => {
    expect(isNativePath(p)).toBe(false);
  });
});

describe('isNativeModuleName', () => {
  it.each(['expo', 'react-native', 'expo-camera', 'react-native-svg', '@expo/vector-icons', '@react-native-community/netinfo'])(
    '%s is native',
    (n) => expect(isNativeModuleName(n)).toBe(true),
  );

  it.each(['zod', 'date-fns', 'lodash', 'typescript', 'react', 'reactnative-helper'])('%s is not native', (n) =>
    expect(isNativeModuleName(n)).toBe(false),
  );
});

describe('majorOf', () => {
  it.each([
    ['^3.5.1', 3],
    ['~52.0.0', 52],
    ['>=4.0.0', 4],
    ['4', 4],
    ['v2.1.0', 2],
  ])('%s -> %i', (range, expected) => expect(majorOf(range as string)).toBe(expected));

  it.each(['*', 'latest', 'workspace:*', undefined])('%s is unparseable', (range) =>
    expect(majorOf(range as string | undefined)).toBeUndefined(),
  );
});

describe('NativeChangeError', () => {
  it('carries structured fields and explains the rebuild requirement', () => {
    const report = detectNativeChange({
      changedFiles: ['ios/Podfile'],
      goodPackageJson: pkg({ 'expo-camera': '16.0.0' }),
      badPackageJson: pkg({ 'expo-camera': '16.0.7' }),
    });
    const err = new NativeChangeError(report, 'v1.2.0', 'HEAD');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NativeChangeError');
    expect(err.changedPaths).toEqual(['ios/Podfile']);
    expect(err.changedNativeModules).toEqual(['expo-camera']);
    expect(err.goodRef).toBe('v1.2.0');
    expect(err.badRef).toBe('HEAD');
    expect(err.message).toContain('needs a fresh binary');
  });

  it('points at the adapters that can build the range for real', () => {
    const report = detectNativeChange({ changedFiles: ['ios/Podfile'] });
    const message = new NativeChangeError(report, 'v1.2.0', 'HEAD').message;

    expect(message).toContain('--framework xcode');
    expect(message).toContain('--framework gradle');
  });
});
