/**
 * Bounded-concurrency artifact fetcher.
 *
 * Revyl hands back presigned S3 URLs that expire (`X-Amz-Expires=3600` on the
 * frames we recorded). A bisect with retries can outlive that window, so
 * evidence is pulled to disk eagerly at collect time rather than lazily at
 * report time, by then the links are gone.
 *
 * This module never throws. Artifact collection is evidence gathering and must
 * not be able to change a commit's verdict.
 */

import { writeFile } from 'node:fs/promises';

/**
 * Structural subset of `fetch`, so this package needs no DOM lib and a test can
 * stub it with a plain function.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface DownloadJob {
  url: string;
  destPath: string;
}

export interface DownloadOutcome extends DownloadJob {
  ok: boolean;
  /** Why it was skipped. Present only when `ok` is false. */
  reason?: string;
}

export interface DownloadOptions {
  fetchImpl?: FetchLike;
  /** Max requests in flight. Default 5. */
  concurrency?: number;
  /** Per-request budget so one hung fetch cannot wedge the search. Default 20s. */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export const DEFAULT_DOWNLOAD_CONCURRENCY = 5;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;

async function downloadOne(job: DownloadJob, fetchImpl: FetchLike, timeoutMs: number): Promise<DownloadOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(job.url, { signal: controller.signal });
    // An expired link 403s. That is expected, not exceptional.
    if (!res.ok) return { ...job, ok: false, reason: `HTTP ${res.status}` };
    await writeFile(job.destPath, Buffer.from(await res.arrayBuffer()));
    return { ...job, ok: true };
  } catch (err) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : String(err);
    return { ...job, ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `jobs` through a fixed-size worker pool. Results keep the input order. */
export async function downloadAll(jobs: DownloadJob[], opts: DownloadOptions = {}): Promise<DownloadOutcome[]> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!jobs.length) return [];
  if (!fetchImpl) {
    opts.onLog?.('no fetch available; skipping artifact downloads');
    return jobs.map((j) => ({ ...j, ok: false, reason: 'no fetch implementation' }));
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY, jobs.length));
  const results = new Array<DownloadOutcome>(jobs.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const outcome = await downloadOne(jobs[i]!, fetchImpl, timeoutMs);
      results[i] = outcome;
      if (!outcome.ok) opts.onLog?.(`skipped artifact ${outcome.destPath}: ${outcome.reason}`);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
