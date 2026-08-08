/**
 * Static server for `export` mode.
 *
 * Deliberately tiny and dependency-free: it serves one `expo export` output dir
 * for the lifetime of a candidate. Binds all interfaces so a relay/tunnel can
 * reach it from the cloud device.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.hbc': 'application/octet-stream',
  '.bundle': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface StaticServer {
  port: number;
  root: string;
  close(): Promise<void>;
}

export async function serveDirectory(root: string, port: number): Promise<StaticServer> {
  const resolvedRoot = path.resolve(root);

  const server = http.createServer((req, res) => {
    void handle(resolvedRoot, req, res);
  });
  server.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });

  return {
    port,
    root: resolvedRoot,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handle(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('packager-status:running');
      return;
    }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // Resolve then re-check the prefix: `..%2f` must not escape the export dir.
    let target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat = await statOrUndefined(target);
    if (stat?.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await statOrUndefined(target);
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
}

async function statOrUndefined(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}
