/**
 * Flow YAML loader.
 *
 * The schema is deliberately thin: we own `name` / `appId` / `expect` / `steps`
 * and each step's `label`, and every other key inside a step is passed to the
 * runner untouched. That keeps the file readable in the report ("Tap Place
 * order") without mobile-bisect having an opinion about Revyl's step vocabulary.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, isMap, isSeq, parseDocument, type Node, type Pair } from 'yaml';
import type { FlowDefinition, FlowStep } from '@mobile-bisect/core';
import { CliError } from './errors.js';

const ROOT_KEYS = ['name', 'appId', 'expect', 'steps', 'description'];

/** A validation failure that can point at a line, with a source excerpt. */
export class FlowError extends CliError {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    message: string,
    opts: { file: string; line?: number; column?: number; source?: string; hint?: string },
  ) {
    const where = opts.line ? `${opts.file}:${opts.line}:${opts.column ?? 1}` : opts.file;
    const excerpt =
      opts.source && opts.line ? `\n\n${excerptAt(opts.source, opts.line, opts.column ?? 1)}` : '';
    super(`${where}  ${message}${excerpt}`, { hint: opts.hint, exitCode: 2 });
    this.name = 'FlowError';
    this.file = opts.file;
    this.line = opts.line;
    this.column = opts.column;
  }
}

function excerptAt(source: string, line: number, column: number): string {
  const lines = source.split('\n');
  const text = lines[line - 1] ?? '';
  const gutter = String(line);
  const pad = ' '.repeat(gutter.length);
  return [
    `  ${gutter} | ${text}`,
    `  ${pad} | ${' '.repeat(Math.max(0, column - 1))}^`,
  ].join('\n');
}

export function parseFlow(source: string, filePath: string): FlowDefinition {
  const counter = new LineCounter();
  const doc = parseDocument(source, { lineCounter: counter });
  const at = (offset: number | undefined): { line?: number; column?: number } => {
    if (offset === undefined) return {};
    const { line, col } = counter.linePos(offset);
    return { line, column: col };
  };

  // A function declaration (not a const arrow) so TS treats it as never-returning
  // and narrows types after each call site.
  function fail(message: string, node?: Node | Pair | null, hint?: string): never {
    const range = nodeRange(node);
    throw new FlowError(message, { file: filePath, source, hint, ...at(range?.[0]) });
  }

  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const pretty = e.linePos?.[0];
    const pos = pretty ? { line: pretty.line, column: pretty.col } : at(e.pos[0]);
    throw new FlowError(e.message.replace(/\s*at line \d+.*$/s, ''), {
      file: filePath,
      source,
      ...pos,
      hint: 'This file is not valid YAML. Check the indentation around that line.',
    });
  }

  const root = doc.contents;
  if (!isMap(root)) {
    throw new FlowError('a flow file must be a YAML mapping with `name` and `steps`.', {
      file: filePath,
      source,
      line: 1,
      column: 1,
      hint: 'See examples/flows/checkout.yaml for the shape.',
    });
  }

  for (const item of root.items) {
    const key = String((item.key as { value?: unknown } | null)?.value ?? '');
    if (!ROOT_KEYS.includes(key)) {
      fail(
        `unknown key \`${key}\`.`,
        item.key as Node,
        `A flow supports: ${ROOT_KEYS.join(', ')}. Per-step keys go under \`steps\`.`,
      );
    }
  }

  const nameNode = root.get('name', true) as Node | undefined;
  const name = scalarString(nameNode);
  if (!name) {
    fail(
      '`name` is required and must be a non-empty string.',
      nameNode ?? root,
      'e.g. `name: checkout-flow`',
    );
  }

  const appIdNode = root.get('appId', true) as Node | undefined;
  if (appIdNode !== undefined && !scalarString(appIdNode)) {
    fail('`appId` must be a string.', appIdNode);
  }

  const expectNode = root.get('expect', true) as Node | undefined;
  if (expectNode !== undefined && !scalarString(expectNode)) {
    fail('`expect` must be a string, the sentence the run has to satisfy.', expectNode);
  }

  const stepsNode = root.get('steps', true) as Node | undefined;
  if (!stepsNode) {
    fail('`steps` is required.', root, 'A flow needs at least one step.');
  }
  if (!isSeq(stepsNode)) {
    fail('`steps` must be a list.', stepsNode, 'Each list item is one step: `- label: ...`');
  }
  if (stepsNode.items.length === 0) {
    fail('`steps` is empty, a flow needs at least one step.', stepsNode);
  }

  const steps: FlowStep[] = stepsNode.items.map((item, i) => {
    const node = item as Node;
    if (!isMap(node)) {
      fail(
        `step ${i + 1} must be a mapping with a \`label\` and an action.`,
        node,
        'e.g. `- label: Open cart` / `  tap: "Cart"`',
      );
    }
    const labelNode = node.get('label', true) as Node | undefined;
    const label = scalarString(labelNode);
    if (!label) {
      fail(
        `step ${i + 1} is missing a \`label\`.`,
        labelNode ?? node,
        'Every step needs a short human label, it is what shows under the phone in the report.',
      );
    }

    const body = node.toJSON() as Record<string, unknown>;
    delete body.label;
    if (Object.keys(body).length === 0) {
      fail(
        `step ${i + 1} ("${label}") has a label but no action.`,
        node,
        'Add the Revyl step body next to the label, e.g. `tap: "Place order"`.',
      );
    }
    return { label, ...body };
  });

  const flow: FlowDefinition = { name: name!, steps };
  const appId = appIdNode ? scalarString(appIdNode) : undefined;
  if (appId) flow.appId = appId;
  const expect = expectNode ? scalarString(expectNode) : undefined;
  if (expect) flow.expect = expect.trim();
  return flow;
}

export async function loadFlow(filePath: string): Promise<FlowDefinition> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch {
    throw new CliError(`Can't read the flow file \`${filePath}\`.`, {
      hint: 'Pass a path with `--flow`, or run `mobile-bisect init` to scaffold one.',
      exitCode: 2,
    });
  }
  return parseFlow(source, path.relative(process.cwd(), filePath) || filePath);
}

/** Where a flow tends to live, in the order we would guess. */
const FLOW_HINTS = [
  'mobile-bisect.flow.yaml',
  'flows/checkout.yaml',
  'flows/checkout.yml',
  '.mobile-bisect/flow.yaml',
];
const FLOW_DIRS = ['flows', '.mobile-bisect/flows', 'e2e/flows', 'e2e', 'tests/flows'];

export async function findFlowFile(cwd: string): Promise<string | undefined> {
  for (const hint of FLOW_HINTS) {
    const full = path.join(cwd, hint);
    if (await exists(full)) return full;
  }
  for (const dir of FLOW_DIRS) {
    const full = path.join(cwd, dir);
    try {
      const names = (await readdir(full))
        .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
        .sort();
      if (names[0]) return path.join(full, names[0]);
    } catch {
      // directory doesn't exist, keep looking
    }
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function nodeRange(node: Node | Pair | null | undefined): [number, number, number] | undefined {
  const range = (node as { range?: [number, number, number] } | undefined)?.range;
  return range ?? undefined;
}

function scalarString(node: Node | undefined): string | undefined {
  const value = (node as { value?: unknown } | undefined)?.value;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}
