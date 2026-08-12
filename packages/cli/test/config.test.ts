/**
 * The config is read, not executed, so the literal reader is the only thing
 * standing between a hand-edited `mobile-bisect.config.ts` and a run that
 * quietly uses the wrong device, the wrong app or the wrong adapter. A misparse
 * here is silent everywhere else, which is what makes it worth pinning.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readConfigLiteral, writeConfig } from '../src/config.js';

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mobile-bisect-config-'));
}

describe('readConfigLiteral', () => {
  it('reads the shape `init` writes', () => {
    const config = readConfigLiteral(
      [
        `import { defineConfig } from 'mobile-bisect';`,
        ``,
        `export default defineConfig({`,
        `  flow: "flows/checkout.yaml",`,
        `  expect: "the order confirmation screen appears",`,
        `  framework: "xcode",`,
        `  platform: "ios",`,
        `  deviceModel: "iPhone 15 Pro",`,
        `  build: {`,
        `    scheme: "Orbit",`,
        `    timeout: 900,`,
        `  },`,
        `});`,
      ].join('\n'),
    );

    expect(config).toEqual({
      flow: 'flows/checkout.yaml',
      expect: 'the order confirmation screen appears',
      framework: 'xcode',
      platform: 'ios',
      deviceModel: 'iPhone 15 Pro',
      build: { scheme: 'Orbit', timeout: 900 },
    });
  });

  it('survives the edits a human makes to it', () => {
    const config = readConfigLiteral(
      [
        `// which flow to run`,
        `export default defineConfig({`,
        `  /* single quotes and a trailing comma */`,
        `  flow: 'flows/checkout.yaml',`,
        `  concurrency: 4,`,
        `  build: { variant: 'debug' }, // gradle`,
        `  maxCandidates: 128`,
        `})`,
      ].join('\n'),
    );

    expect(config).toEqual({
      flow: 'flows/checkout.yaml',
      concurrency: 4,
      build: { variant: 'debug' },
      maxCandidates: 128,
    });
  });

  it('does not mistake a comment marker inside a string for a comment', () => {
    const config = readConfigLiteral(
      `export default defineConfig({ expect: "the // banner is gone", appId: "a/*b*/c" })`,
    );
    expect(config.expect).toBe('the // banner is gone');
    expect(config.appId).toBe('a/*b*/c');
  });

  it('reads a plain object export as well as a defineConfig call', () => {
    expect(readConfigLiteral(`export default { platform: "android" }`)).toEqual({
      platform: 'android',
    });
  });

  it('refuses a value it would have to run the file to know', () => {
    expect(() =>
      readConfigLiteral(`export default defineConfig({ expect: readFileSync('x') })`),
    ).toThrow(/without running the file/);
  });

  it('refuses a file with no config object at all', () => {
    expect(() => readConfigLiteral(`const x = 1;`)).toThrow(/no `defineConfig/);
  });
});

describe('loadConfig', () => {
  it('returns an empty config when the project has none', async () => {
    expect(await loadConfig(await dir())).toEqual({ config: {} });
  });

  it('round-trips what writeConfig wrote', async () => {
    const cwd = await dir();
    const original = {
      flow: 'flows/checkout.yaml',
      expect: 'the order confirmation screen appears',
      framework: 'gradle' as const,
      platform: 'android' as const,
      appId: '3ff00ca7-0000-4000-8000-000000000000',
      timeout: 600,
      build: { module: 'app', variant: 'debug' },
    };

    const written = await writeConfig(cwd, original);
    expect(written.written).toBe(true);

    const { config, path: from } = await loadConfig(cwd);
    expect(from).toBe(written.path);
    expect(config).toEqual(original);
  });

  it('does not overwrite an existing config without force', async () => {
    const cwd = await dir();
    await writeConfig(cwd, { platform: 'ios' });
    expect((await writeConfig(cwd, { platform: 'android' })).written).toBe(false);
    expect((await loadConfig(cwd)).config.platform).toBe('ios');

    expect((await writeConfig(cwd, { platform: 'android' }, { force: true })).written).toBe(true);
    expect((await loadConfig(cwd)).config.platform).toBe('android');
  });

  it('reads a .json config too', async () => {
    const cwd = await dir();
    await writeFile(
      path.join(cwd, 'mobile-bisect.config.json'),
      JSON.stringify({ framework: 'expo', build: { timeout: 120 } }),
    );
    expect((await loadConfig(cwd)).config).toEqual({ framework: 'expo', build: { timeout: 120 } });
  });

  it('names the file when it cannot be read', async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, 'mobile-bisect.config.ts'), `export const nope = 1;\n`);
    await expect(loadConfig(cwd)).rejects.toThrow(/mobile-bisect\.config\.ts/);
  });
});
