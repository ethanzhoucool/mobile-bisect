/**
 * `expo-bisect.config.ts` support.
 *
 * The config is a TypeScript file because that is what an Expo project expects
 * to see, but Node 18 cannot import one. Rather than pull in a transpiler we
 * read the object literal directly — the file we write is always a single
 * `defineConfig({...})` call, and hand-edits stay within that shape.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './errors.js';

export interface ExpoBisectConfig {
  /** Default flow, relative to the project root. */
  flow?: string;
  /** Default natural-language assertion. */
  expect?: string;
  platform?: 'ios' | 'android';
  deviceModel?: string;
  osVersion?: string;
  /** Simulator development build (.app) or an EAS build id. */
  build?: { appPath?: string; buildId?: string };
  appId?: string;
  maxCandidates?: number;
  concurrency?: number;
  /** Per-candidate flow timeout, in seconds. */
  timeout?: number;
  port?: number;
}

export const CONFIG_FILENAMES = [
  'expo-bisect.config.ts',
  'expo-bisect.config.mts',
  'expo-bisect.config.js',
  'expo-bisect.config.mjs',
  'expo-bisect.config.json',
];

export function defineConfig(config: ExpoBisectConfig): ExpoBisectConfig {
  return config;
}

export async function findConfig(cwd: string): Promise<string | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const full = path.join(cwd, name);
    if (await exists(full)) return full;
  }
  return undefined;
}

export async function loadConfig(cwd: string): Promise<{ config: ExpoBisectConfig; path?: string }> {
  const file = await findConfig(cwd);
  if (!file) return { config: {} };

  if (file.endsWith('.json')) {
    return { config: JSON.parse(await readFile(file, 'utf8')) as ExpoBisectConfig, path: file };
  }

  // A JS config can just be imported; a TS one is read as a literal.
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    try {
      const mod = (await import(`file://${file}`)) as { default?: ExpoBisectConfig };
      if (mod.default) return { config: mod.default, path: file };
    } catch {
      // fall through to the literal reader
    }
  }

  const source = await readFile(file, 'utf8');
  try {
    return { config: readConfigLiteral(source), path: file };
  } catch (e) {
    throw new CliError(
      `Couldn't read ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`,
      { hint: 'Keep the file to a single `defineConfig({ ... })` object, or use a .json config.' },
    );
  }
}

export async function writeConfig(
  cwd: string,
  config: ExpoBisectConfig,
  opts: { force?: boolean } = {},
): Promise<{ path: string; written: boolean }> {
  const target = path.join(cwd, 'expo-bisect.config.ts');
  if (!opts.force && (await exists(target))) return { path: target, written: false };

  const body = [
    `import { defineConfig } from 'expo-bisect';`,
    ``,
    `export default defineConfig({`,
    ...renderEntries(config as unknown as Record<string, unknown>, '  '),
    `});`,
    ``,
  ].join('\n');

  await writeFile(target, body, 'utf8');
  return { path: target, written: true };
}

function renderEntries(value: Record<string, unknown>, indent: string): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = renderEntries(v as Record<string, unknown>, `${indent}  `);
      if (nested.length === 0) continue;
      out.push(`${indent}${key}: {`, ...nested, `${indent}},`);
    } else {
      out.push(`${indent}${key}: ${JSON.stringify(v)},`);
    }
  }
  return out;
}

// --- literal reader --------------------------------------------------------

/** Reads the object literal out of `defineConfig({...})` / `export default {...}`. */
export function readConfigLiteral(source: string): ExpoBisectConfig {
  const stripped = stripComments(source);
  const marker = /defineConfig\s*\(\s*|export\s+default\s*/g;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(stripped)) !== null) {
    const idx = stripped.indexOf('{', m.index + m[0].length - 1);
    if (idx !== -1) {
      start = idx;
      break;
    }
  }
  if (start === -1) throw new Error('no `defineConfig({ ... })` object found');

  const reader = new LiteralReader(stripped, start);
  const value = reader.readValue();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the config default export must be an object');
  }
  return value as ExpoBisectConfig;
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = findStringEnd(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function findStringEnd(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return src.length;
}

class LiteralReader {
  constructor(
    private readonly src: string,
    private pos: number,
  ) {}

  readValue(): unknown {
    this.skipSpace();
    const c = this.src[this.pos];
    if (c === '{') return this.readObject();
    if (c === '[') return this.readArray();
    if (c === '"' || c === "'" || c === '`') return this.readString();
    return this.readWord();
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  private readObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.pos++; // {
    for (;;) {
      this.skipSpace();
      const c = this.src[this.pos];
      if (c === undefined) throw new Error('unterminated object literal');
      if (c === '}') {
        this.pos++;
        return out;
      }
      if (c === ',') {
        this.pos++;
        continue;
      }
      const key =
        c === '"' || c === "'" || c === '`' ? this.readString() : this.readIdentifier();
      this.skipSpace();
      if (this.src[this.pos] !== ':') throw new Error(`expected ':' after key \`${key}\``);
      this.pos++;
      out[key] = this.readValue();
    }
  }

  private readArray(): unknown[] {
    const out: unknown[] = [];
    this.pos++; // [
    for (;;) {
      this.skipSpace();
      const c = this.src[this.pos];
      if (c === undefined) throw new Error('unterminated array literal');
      if (c === ']') {
        this.pos++;
        return out;
      }
      if (c === ',') {
        this.pos++;
        continue;
      }
      out.push(this.readValue());
    }
  }

  private readString(): string {
    const end = findStringEnd(this.src, this.pos);
    const raw = this.src.slice(this.pos + 1, end - 1);
    this.pos = end;
    return raw.replace(/\\(.)/g, (_, ch: string) =>
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
    );
  }

  private readIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.pos]!)) this.pos++;
    if (this.pos === start) throw new Error(`unexpected character \`${this.src[start]}\``);
    return this.src.slice(start, this.pos);
  }

  private readWord(): unknown {
    const start = this.pos;
    while (this.pos < this.src.length && !/[,}\]\s]/.test(this.src[this.pos]!)) this.pos++;
    const word = this.src.slice(start, this.pos);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null' || word === 'undefined') return undefined;
    const n = Number(word);
    if (!Number.isNaN(n) && word !== '') return n;
    // An expression (a call, a variable) — not something we can evaluate safely.
    throw new Error(`can't read the value \`${word}\` without running the file`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
