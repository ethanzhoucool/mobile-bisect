import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseLines, readEvents, resolveRun } from './loadEvents.js';
import { renderHtml } from './template.js';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.har': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
};
/**
 * Tails events.jsonl and fans complete lines out to every SSE client.
 * fs.watch is unreliable across platforms/editors, so a slow poll backs it up.
 */
class Tail {
    path;
    offset = 0;
    partial = '';
    watcher;
    timer;
    clients = new Set();
    reading = false;
    constructor(path) {
        this.path = path;
    }
    start() {
        if (existsSync(this.path))
            this.offset = statSync(this.path).size;
        const kick = () => void this.pump();
        try {
            this.watcher = watch(this.path, kick);
        }
        catch {
            /* file may not exist yet — the poll below picks it up */
        }
        this.timer = setInterval(kick, 500);
    }
    add(res) {
        this.clients.add(res);
        res.on('close', () => this.clients.delete(res));
    }
    async pump() {
        if (this.reading || !existsSync(this.path))
            return;
        const size = statSync(this.path).size;
        if (size < this.offset) {
            this.offset = 0; // file was rewritten
            this.partial = '';
        }
        if (size === this.offset)
            return;
        this.reading = true;
        try {
            const fh = await open(this.path, 'r');
            const len = size - this.offset;
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, this.offset);
            await fh.close();
            this.offset = size;
            const text = this.partial + buf.toString('utf8');
            const lines = text.split('\n');
            this.partial = lines.pop() ?? '';
            for (const ev of parseLines(lines.join('\n'))) {
                const payload = `event: bisect\ndata: ${JSON.stringify(ev)}\n\n`;
                for (const c of this.clients)
                    c.write(payload);
            }
        }
        finally {
            this.reading = false;
        }
    }
    stop() {
        this.watcher?.close();
        if (this.timer)
            clearInterval(this.timer);
        for (const c of this.clients)
            c.end();
        this.clients.clear();
    }
}
function serveFile(root, rel, res) {
    const target = resolve(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory())
        return false;
    res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
    return true;
}
/** Serves the report at `/` and streams new events over SSE at `/events`. */
export async function serve(opts) {
    const { runDir, eventsPath } = await resolveRun(opts.runDir);
    const tail = new Tail(eventsPath);
    const handler = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (path === '/events') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            tail.add(res);
            return;
        }
        if (path === '/events.json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(await readEvents(eventsPath)));
            return;
        }
        if (path === '/' || path === '/index.html') {
            const html = await renderHtml({
                events: await readEvents(eventsPath),
                config: {
                    mode: 'live',
                    sseUrl: '/events',
                    runDir,
                    allowRemoteMedia: opts.allowRemoteMedia ?? true,
                },
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html);
            return;
        }
        // Local artifacts (videos, screenshots) live under the run dir.
        if (serveFile(runDir, path.slice(1), res))
            return;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    };
    const server = createServer((req, res) => {
        handler(req, res).catch((err) => {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(err?.stack ?? err));
        });
    });
    const port = opts.port ?? 4713;
    await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, ok);
    });
    const actual = server.address().port;
    const url = `http://localhost:${actual}`;
    tail.start();
    if (opts.open) {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    }
    return {
        url,
        close: () => new Promise((ok) => {
            tail.stop();
            server.close(() => ok());
            server.closeAllConnections?.();
        }),
    };
}
export { join as _join };
//# sourceMappingURL=serve.js.map