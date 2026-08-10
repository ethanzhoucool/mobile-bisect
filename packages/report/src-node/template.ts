import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The single-file app bundle both outputs are built from. */
export function templatePath(): string {
  const candidates = [
    join(here, '..', 'dist', 'index.html'),
    join(here, '..', '..', 'dist', 'index.html'),
  ];
  for (const c of candidates) if (existsSync(c)) return resolve(c);
  throw new Error(
    `@mobile-bisect/report: app bundle not found. Run "npm run build:app" in packages/report first (looked in ${candidates.join(', ')}).`,
  );
}

/** Safe to embed inside <script type="application/json">. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface RenderOptions {
  events: unknown[];
  config: Record<string, unknown>;
  /** originalUrl -> data: URI. Emitted once per asset, not once per reference. */
  frames?: Record<string, string>;
}

export async function renderHtml({ events, config, frames }: RenderOptions): Promise<string> {
  const html = await readFile(templatePath(), 'utf8');
  return html
    .replace('"__MOBILE_BISECT_CONFIG__"', inlineJson(config))
    .replace('"__MOBILE_BISECT_FRAMES__"', inlineJson(frames ?? {}))
    .replace('"__MOBILE_BISECT_EVENTS__"', inlineJson(events));
}
