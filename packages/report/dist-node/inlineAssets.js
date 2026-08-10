import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
const MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};
function isRemote(u) {
    return /^https?:\/\//i.test(u);
}
async function fetchBytes(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return {
            buf: Buffer.from(await res.arrayBuffer()),
            type: res.headers.get('content-type')?.split(';')[0] ?? undefined,
        };
    }
    finally {
        clearTimeout(timer);
    }
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
export async function inlineFrames(events, runDir, opts = {}) {
    const { maxBytesPerAsset = 3_000_000, maxTotalBytes = 9_000_000, timeoutMs = 20_000, concurrency = 6, } = opts;
    let priority = new Set();
    for (const ev of events) {
        const e = ev;
        if (e?.type === 'culprit.found')
            priority = new Set([e.goodSha, e.badSha]);
    }
    const first = [];
    const rest = [];
    for (const ev of events) {
        const e = ev;
        if (e?.type !== 'commit.completed')
            continue;
        const bucket = priority.has(e.result?.sha ?? '') ? first : rest;
        // Local copies first: they are already on disk, they never expire, and
        // their filenames carry the step number the playhead needs.
        for (const list of [e.result?.localPaths, e.result?.screenshots]) {
            if (!Array.isArray(list))
                continue;
            for (const s of list)
                if (typeof s === 'string' && !s.startsWith('data:'))
                    bucket.push(s);
        }
    }
    const queue = [...new Set([...first, ...rest])];
    const map = {};
    const stats = { inlined: 0, skipped: 0, bytes: 0, failed: [] };
    let cursor = 0;
    const worker = async () => {
        while (cursor < queue.length) {
            const url = queue[cursor++];
            if (stats.bytes >= maxTotalBytes) {
                stats.skipped++;
                continue;
            }
            try {
                let buf;
                let type;
                if (isRemote(url)) {
                    ({ buf, type } = await fetchBytes(url, timeoutMs));
                }
                else {
                    const p = isAbsolute(url) ? url : resolve(runDir, url);
                    if (!existsSync(p))
                        throw new Error('not found');
                    buf = await readFile(p);
                }
                if (buf.byteLength > maxBytesPerAsset)
                    throw new Error(`too large (${buf.byteLength}B)`);
                if (stats.bytes + buf.byteLength > maxTotalBytes) {
                    stats.skipped++;
                    continue;
                }
                const ext = extname(url.split('?')[0]).toLowerCase();
                map[url] = `data:${type ?? MIME[ext] ?? 'image/png'};base64,${buf.toString('base64')}`;
                stats.inlined++;
                stats.bytes += buf.byteLength;
            }
            catch (err) {
                stats.failed.push({ url, reason: err.message });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) || 1 }, worker));
    return { map, stats };
}
//# sourceMappingURL=inlineAssets.js.map