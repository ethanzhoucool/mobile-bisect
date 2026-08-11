import { type InlineStats } from './inlineAssets.js';
export interface RenderReportOptions {
    /** Run directory containing events.jsonl, or the .jsonl file itself. */
    runDir: string;
    /** Defaults to <runDir>/report.html. */
    outPath?: string;
    /**
     * Download captured step frames and embed them as data: URIs. On by default -
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
 * Writes a single self-contained report.html, CSS, JS, events and captured
 * frames all inlined, that opens from file:// with no network.
 */
export declare function renderReportDetailed(opts: RenderReportOptions): Promise<RenderReportResult>;
/** Convenience wrapper: resolves to the written path. */
export declare function renderReport(opts: RenderReportOptions): Promise<string>;
