/**
 * The packaging half, against the real tools.
 *
 * The rest of the suite stubs the executor, which proves the adapters *call*
 * `zip` and `plutil` correctly but not that the calls do what we think. These
 * two are system utilities — cheap to run for real, unlike the compilers — so
 * the archive is actually produced and actually read back here.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSimulatorApp, readBundleId, zipApp } from './artifact.js';
import { fakeSimulatorApp } from './test-helpers.js';

const exec = promisify(execFile);

async function has(tool: string): Promise<boolean> {
  try {
    await exec('which', [tool]);
    return true;
  } catch {
    return false;
  }
}

const HAS_ZIP = await has('zip');
const HAS_UNZIP = await has('unzip');
const HAS_PLUTIL = process.platform === 'darwin' && (await has('plutil'));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-real-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!HAS_ZIP)('zipApp against the real zip', () => {
  it('produces an archive containing the bundle at the top level', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const out = path.join(root, 'out', 'Orbit.app.zip');

    await zipApp(app, out);

    expect((await stat(out)).size).toBeGreaterThan(0);
    // The first bytes are the zip local-file-header magic.
    const head = await readFile(out);
    expect(head.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it.skipIf(!HAS_UNZIP)('stores paths relative to the bundle, never absolute', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const out = path.join(root, 'out', 'Orbit.app.zip');
    await zipApp(app, out);

    const { stdout } = await exec('unzip', ['-l', out]);
    // `unzip -l` opens with `Archive:  <the path we just passed it>`, which of
    // course contains the temp dir. Only the entry rows say how paths were stored.
    const entries = stdout
      .split('\n')
      .filter((l) => !l.startsWith('Archive:'))
      .filter((l) => l.includes('Orbit.app'));

    // An installer expects `Orbit.app/...`; an absolute path fails to install.
    expect(entries.some((l) => l.includes('Orbit.app/Info.plist'))).toBe(true);
    for (const line of entries) expect(line).not.toContain(root);
  });

  it('overwrites a previous archive rather than appending to it', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    const out = path.join(root, 'out', 'Orbit.app.zip');

    await zipApp(app, out);
    const first = (await stat(out)).size;
    await zipApp(app, out);
    const second = (await stat(out)).size;

    expect(second).toBe(first);
  });
});

describe.skipIf(!HAS_PLUTIL)('readBundleId against the real plutil', () => {
  it('reads CFBundleIdentifier out of an Info.plist', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit', 'com.orbit.store');
    expect(await readBundleId(app)).toBe('com.orbit.store');
  });

  it('is undefined for a bundle with no Info.plist, instead of throwing', async () => {
    const app = await fakeSimulatorApp(root, 'Debug', 'Orbit');
    await rm(path.join(app, 'Info.plist'));
    expect(await readBundleId(app)).toBeUndefined();
  });
});

describe('findSimulatorApp on a real directory tree', () => {
  it('finds the newest bundle across configurations', async () => {
    await fakeSimulatorApp(root, 'Release', 'Orbit');
    await fakeSimulatorApp(root, 'Debug', 'Orbit');

    const found = await findSimulatorApp(root, 'Debug');
    expect(found?.path).toContain('Debug-iphonesimulator');
    expect((await stat(found!.path)).isDirectory()).toBe(true);
  });
});
