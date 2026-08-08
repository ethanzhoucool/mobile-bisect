import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
/** Accepts a run directory or a path straight to an events .jsonl (handy for fixtures). */
export async function resolveRun(runDirOrFile) {
    const p = isAbsolute(runDirOrFile) ? runDirOrFile : resolve(process.cwd(), runDirOrFile);
    let isDir = false;
    try {
        isDir = (await stat(p)).isDirectory();
    }
    catch {
        isDir = !p.endsWith('.jsonl');
    }
    return isDir
        ? { runDir: p, eventsPath: join(p, 'events.jsonl') }
        : { runDir: dirname(p), eventsPath: p };
}
export function parseLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            out.push(JSON.parse(s));
        }
        catch {
            /* a half-written trailing line during a live run — skip it */
        }
    }
    return out;
}
export async function readEvents(eventsPath) {
    if (!existsSync(eventsPath))
        return [];
    return parseLines(await readFile(eventsPath, 'utf8'));
}
//# sourceMappingURL=loadEvents.js.map