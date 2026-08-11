import path from 'node:path';
import pc from 'picocolors';
import { RunStore } from '@mobile-bisect/core';
import { loadReport } from '../adapters.js';
import type { ReportOptions } from '../args.js';
import { openInBrowser } from '../browser.js';
import { CliError, messageOf } from '../errors.js';

export async function reportCommand(opts: ReportOptions): Promise<number> {
  const repo = path.resolve(opts.cwd);
  const store = await pickRun(repo, opts.runId);

  const events = await store.readEvents();
  if (events.length === 0) {
    throw new CliError(`Run \`${store.runId}\` has no events to report on.`, {
      hint: 'Runs live in .mobile-bisect/runs, `mobile-bisect report <run-id>` picks a specific one.',
    });
  }

  const report = await loadReport();
  let outPath: string;
  try {
    outPath = await report.renderReport({
      runDir: store.dir,
      outPath: opts.out ? path.resolve(repo, opts.out) : undefined,
    });
  } catch (e) {
    throw new CliError(`Could not render the report: ${messageOf(e)}`);
  }

  const relative = path.relative(repo, outPath) || outPath;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ runId: store.runId, reportPath: outPath })}\n`);
  } else {
    process.stdout.write(`\n  ${pc.dim('report')}  ${pc.cyan(relative)}\n\n`);
  }

  if (opts.open && !opts.json) openInBrowser(`file://${outPath}`);
  return 0;
}

async function pickRun(repo: string, runId?: string): Promise<RunStore> {
  if (runId) return RunStore.open(repo, runId);
  const latest = await RunStore.latest(repo);
  if (latest) return latest;
  throw new CliError('No runs found in this project.', {
    hint: 'Start one with `mobile-bisect run --good <ref> --bad HEAD`.',
  });
}
