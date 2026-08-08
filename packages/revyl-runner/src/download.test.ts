import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadAll, type FetchLike } from './download.js';

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dl-'));
}

const okFetch =
  (body = 'PNG'): FetchLike =>
  async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) });

describe('downloadAll', () => {
  it('writes every file and keeps result order', async () => {
    const d = await dir();
    const jobs = [0, 1, 2].map((i) => ({ url: `https://s3/${i}.png`, destPath: join(d, `${i}.png`) }));
    const results = await downloadAll(jobs, { fetchImpl: okFetch('frame') });

    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results.map((r) => r.url)).toEqual(jobs.map((j) => j.url));
    for (const j of jobs) expect(await readFile(j.destPath, 'utf8')).toBe('frame');
  });

  it('skips an expired link without failing the batch', async () => {
    const d = await dir();
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('1.png')
        ? { ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) }
        : { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ok') };

    const results = await downloadAll(
      [0, 1, 2].map((i) => ({ url: `https://s3/${i}.png`, destPath: join(d, `${i}.png`) })),
      { fetchImpl },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]!.reason).toBe('HTTP 403');
  });

  it('swallows a thrown fetch', async () => {
    const d = await dir();
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const results = await downloadAll([{ url: 'https://s3/a.png', destPath: join(d, 'a.png') }], { fetchImpl });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.reason).toMatch(/ECONNRESET/);
  });

  it('aborts a hung fetch on its own timeout', async () => {
    const d = await dir();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const results = await downloadAll([{ url: 'https://s3/a.png', destPath: join(d, 'a.png') }], {
      fetchImpl,
      timeoutMs: 40,
    });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.reason).toMatch(/timed out after 40ms/);
  });

  it('caps requests in flight', async () => {
    const d = await dir();
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('x') };
    };
    const jobs = Array.from({ length: 20 }, (_v, i) => ({
      url: `https://s3/${i}.png`,
      destPath: join(d, `${i}.png`),
    }));
    await downloadAll(jobs, { fetchImpl, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('is a no-op on an empty job list', async () => {
    await expect(downloadAll([])).resolves.toEqual([]);
  });
});
