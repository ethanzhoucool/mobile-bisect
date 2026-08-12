/**
 * The live view serves a run directory, and a run directory is evidence: the
 * app's screens, its logs, its network trace. So the server has two jobs beyond
 * rendering, hand out nothing above the run dir, and be reachable from this
 * machine only.
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serve, type ServeHandle } from './serve.js';

/** This machine's first non-loopback IPv4, when it has one. */
function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

let handle: ServeHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function runDirWithArtifact(): Promise<{ dir: string; secret: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'mobile-bisect-serve-'));
  const dir = join(parent, 'run');
  await mkdir(join(dir, 'artifacts'), { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), '');
  await writeFile(join(dir, 'artifacts', 'step-01.txt'), 'a frame');
  const secret = join(parent, 'outside.txt');
  await writeFile(secret, 'not yours');
  return { dir, secret };
}

describe('serve', () => {
  it('serves artifacts under the run dir and refuses everything above it', async () => {
    const { dir } = await runDirWithArtifact();
    handle = await serve({ runDir: dir, port: 0 });

    const ok = await fetch(`${handle.url}/artifacts/step-01.txt`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('a frame');

    // Plain, encoded and doubled-up traversal all have to land on 404.
    for (const path of [
      '/../outside.txt',
      '/artifacts/../../outside.txt',
      '/%2e%2e/outside.txt',
      '/..%2f..%2foutside.txt',
      '/%2Fetc%2Fhosts',
    ]) {
      const res = await fetch(`${handle.url}${path}`);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 404`);
    }
  });

  it.skipIf(!lanAddress())(
    'binds loopback only, so a run is not readable from the network',
    async () => {
      const { dir } = await runDirWithArtifact();
      handle = await serve({ runDir: dir, port: 0 });
      const port = Number(new URL(handle.url).port);

      // Loopback answers, this machine's own LAN address does not.
      expect((await fetch(`http://127.0.0.1:${port}/events.json`)).status).toBe(200);
      await expect(fetch(`http://${lanAddress()}:${port}/events.json`)).rejects.toThrow();
    },
  );
});
