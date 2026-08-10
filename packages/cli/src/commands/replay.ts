/**
 * Drive the live view from a recorded event stream.
 *
 * Useful for demos and for working on the UI without burning device minutes:
 * the terminal view and (with --port) the browser see exactly what a real run
 * would produce, paced by the timestamps in the fixture.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { RunStore, type BisectEvent } from '@mobile-bisect/core';
import { loadReport } from '../adapters.js';
import type { ReplayOptions } from '../args.js';
import { CliError } from '../errors.js';
import { LiveSink } from '../ui/live.js';
import { JsonSink, PlainSink } from '../ui/plain.js';
import { fanout, type EventSink } from '../ui/sink.js';

/** Long gaps in a recording are dead air; nobody wants to watch them. */
const MAX_GAP_MS = 3000;

export async function replayCommand(opts: ReplayOptions): Promise<number> {
  const file = path.resolve(opts.cwd, opts.fixture);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new CliError(`Can't read the fixture \`${opts.fixture}\`.`, {
      hint: 'Point at an events.jsonl file, e.g. fixtures/demo-runs/orbit-checkout.jsonl',
      exitCode: 2,
    });
  }

  const events = parseEvents(raw);
  if (events.length === 0) {
    throw new CliError(`\`${opts.fixture}\` has no events in it.`, { exitCode: 2 });
  }

  const sinks: EventSink[] = [];
  const interactive = opts.ui && process.stdout.isTTY === true && !process.env.NO_COLOR;
  if (opts.json) sinks.push(new JsonSink());
  else if (interactive) sinks.push(new LiveSink());
  else sinks.push(new PlainSink());
  const ui = fanout(sinks);

  // Only materialise a run directory when someone wants to watch in a browser.
  let store: RunStore | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  if (opts.port !== undefined && !opts.json) {
    store = await RunStore.create(path.resolve(opts.cwd), `replay-${stamp()}`);
    const report = await loadReport();
    const server = await report.serve({ runDir: store.dir, port: opts.port, open: opts.open });
    closeServer = () => server.close();
    ui.note(pc.dim(`  live view  ${pc.cyan(server.url)}  (replay of ${opts.fixture})`));
  }

  try {
    let previous: number | undefined;
    for (const event of events) {
      const at = Date.parse(event.at);
      if (previous !== undefined && Number.isFinite(at)) {
        const gap = Math.min(MAX_GAP_MS, Math.max(0, at - previous)) / opts.speed;
        if (gap > 0) await sleep(gap);
      }
      if (Number.isFinite(at)) previous = at;
      ui.handle(event);
      await store?.append(event);
    }
  } finally {
    await ui.close();
    await closeServer?.();
  }
  return 0;
}

function parseEvents(raw: string): BisectEvent[] {
  const out: BisectEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as BisectEvent);
    } catch {
      // A torn final line just means the recording was interrupted.
    }
  }
  return out;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
