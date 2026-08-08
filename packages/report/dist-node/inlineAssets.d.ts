export interface InlineOptions {
    /** Skip any single asset larger than this. */
    maxBytesPerAsset?: number;
    /** Stop once the embedded assets would exceed this (pre-base64). */
    maxTotalBytes?: number;
    timeoutMs?: number;
    concurrency?: number;
}
export interface InlineStats {
    inlined: number;
    skipped: number;
    bytes: number;
    failed: {
        url: string;
        reason: string;
    }[];
}
export interface InlineResult {
    /** originalUrl -> data: URI. Emitted once per asset in the HTML. */
    map: Record<string, string>;
    stats: InlineStats;
}
/**
 * Downloads every captured frame and returns a url -> data: URI table.
 *
 * Revyl hands back presigned S3 links that expire in ~15 minutes, so a static
 * report that merely references them is a page of broken images by the time
 * anyone opens it. Fetching while the signature is live is the only way the
 * file stays self-contained.
 *
 * Device screenshots are big, so the culprit pair is fetched first: if the
 * budget runs out, the payoff comparison is still fully backed by real frames
 * and earlier rounds fall back to the drawn placeholder.
 */
export declare function inlineFrames(events: unknown[], runDir: string, opts?: InlineOptions): Promise<InlineResult>;
