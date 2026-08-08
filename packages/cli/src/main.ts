import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { helpText, parseArgs } from './args.js';
import { initCommand } from './commands/init.js';
import { replayCommand } from './commands/replay.js';
import { reportCommand } from './commands/report.js';
import { CliError, isCliError, messageOf } from './errors.js';
import { resumeCommand, runCommand } from './run.js';

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'help':
        process.stdout.write(`${helpText(args.topic)}\n`);
        return 0;
      case 'version':
        process.stdout.write(`${await version()}\n`);
        return 0;
      case 'init':
        return await initCommand(args);
      case 'run':
        return await runCommand(args);
      case 'resume':
        return await resumeCommand(args);
      case 'report':
        return await reportCommand(args);
      case 'replay':
        return await replayCommand(args);
    }
  } catch (e) {
    return report(e);
  }
}

function report(e: unknown): number {
  const error = isCliError(e) ? e : new CliError(messageOf(e));
  process.stderr.write(`\n  ${pc.red('✖')} ${error.message}\n`);
  if (error.hint) process.stderr.write(`    ${pc.dim(`↳ ${error.hint}`)}\n`);
  process.stderr.write('\n');
  return error.exitCode;
}

async function version(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
