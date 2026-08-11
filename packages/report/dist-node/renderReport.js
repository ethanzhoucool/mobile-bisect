import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readEvents, resolveRun } from './loadEvents.js';
import { inlineFrames } from './inlineAssets.js';
import { renderHtml } from './template.js';
/**
 * Writes a single self-contained report.html, CSS, JS, events and captured
 * frames all inlined, that opens from file:// with no network.
 */
export async function renderReportDetailed(opts) {
    const { runDir, eventsPath } = await resolveRun(opts.runDir);
    const events = await readEvents(eventsPath);
    const out = opts.outPath
        ? isAbsolute(opts.outPath)
            ? opts.outPath
            : resolve(process.cwd(), opts.outPath)
        : join(runDir, 'report.html');
    let frames = { inlined: 0, skipped: 0, bytes: 0, failed: [] };
    let frameMap = {};
    if (opts.inlineAssets !== false) {
        ({ map: frameMap, stats: frames } = await inlineFrames(events, runDir));
        if (frames.failed.length) {
            const warn = opts.onWarn ?? ((m) => console.warn(m));
            warn(`mobile-bisect report: ${frames.failed.length} frame(s) could not be inlined ` +
                `(first: ${frames.failed[0].url}, ${frames.failed[0].reason})`);
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
export async function renderReport(opts) {
    return (await renderReportDetailed(opts)).outPath;
}
//# sourceMappingURL=renderReport.js.map