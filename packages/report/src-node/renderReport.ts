import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readEvents, resolveRun } from './loadEvents.js';
import { inlineFrames, type InlineStats } from './inlineAssets.js';
import { renderHtml } from './template.js';

export interface RenderReportOptions {
  /** Run directory containing events.jsonl, or the .jsonl file itself. */
  runDir: string;
  /** Defaults to <runDir>/report.html. */
  outPath?: string;
  /**
   * Download captured step frames and embed them as data: URIs. On by default —
   * without it a shipped report points at expired presigned links.
   */
  inlineAssets?: boolean;
  /** Permit http(s) artifact URLs that were NOT inlined. Off by default. */
  allowRemoteMedia?: boolean;
  onWarn?: (message: string) => void;
}

export interface RenderReportResult {
  outPath: string;
  frames: InlineStats;
}

/**
 * Writes a single self-contained report.html — CSS, JS, events and captured
 * frames all inlined — that opens from file:// with no network.
 */
export async function renderReportDetailed(
  opts: RenderReportOptions,
): Promise<RenderReportResult> {
  const { runDir, eventsPath } = await resolveRun(opts.runDir);
  const events = await readEvents(eventsPath);
  const out = opts.outPath
    ? isAbsolute(opts.outPath)
      ? opts.outPath
      : resolve(process.cwd(), opts.outPath)
    : join(runDir, 'report.html');

  let frames: InlineStats = { inlined: 0, skipped: 0, bytes: 0, failed: [] };
  let frameMap: Record<string, string> = {};
  if (opts.inlineAssets !== false) {
    ({ map: frameMap, stats: frames } = await inlineFrames(events, runDir));
    if (frames.failed.length) {
      const warn = opts.onWarn ?? ((m: string) => console.warn(m));
      warn(
        `expo-bisect report: ${frames.failed.length} frame(s) could not be inlined ` +
          `(first: ${frames.failed[0].url} — ${frames.failed[0].reason})`,
      );
    }
  }

  const html = await renderHtml({
    events,
    frames: frameMap,
    config: {
      mode: 'replay',
      generatedFrom: eventsPath,
      framesInlined: frames.inlined,
      allowRemoteMedia: !!opts.allowRemoteMedia,
    },
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, 'utf8');
  return { outPath: out, frames };
}

/** Convenience wrapper: resolves to the written path. */
export async function renderReport(opts: RenderReportOptions): Promise<string> {
  return (await renderReportDetailed(opts)).outPath;
}
