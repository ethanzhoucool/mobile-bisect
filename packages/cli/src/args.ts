/**
 * Hand-rolled argument parser.
 *
 * Small enough to avoid a dependency, and it lets us do the one thing a generic
 * parser will not: hard-refuse credential flags (see SECRET_FLAGS) so a key can
 * never end up in a shell history, a CI log, or `ps`.
 */

import { CliError } from './errors.js';

/** Kept in step with FRAMEWORK_NAMES in frameworks.ts, which owns the aliases. */
export type FrameworkName = 'expo' | 'xcode' | 'gradle' | 'revyl-remote';

export type Command = 'init' | 'run' | 'resume' | 'report' | 'replay' | 'help' | 'version';

export interface CommonOptions {
  cwd: string;
}

export interface RunOptions extends CommonOptions {
  command: 'run';
  good: string;
  bad: string;
  flow?: string;
  expect?: string;
  deviceModel?: string;
  osVersion?: string;
  platform: 'ios' | 'android';
  /** Which framework adapter prepares candidates. Undefined = detect. */
  framework?: FrameworkName;
  /** Xcode: the scheme to build. Overrides `build.scheme`. */
  scheme?: string;
  /** Gradle: the variant to assemble. Overrides `build.variant`. */
  variant?: string;
  /** Subdirectory holding the native project. Overrides `build.projectDir`. */
  projectDir?: string;
  concurrency: number;
  maxCandidates: number;
  timeoutMs: number;
  allowDirty: boolean;
  dryRun: boolean;
  port: number;
  ui: boolean;
  json: boolean;
  open: boolean;
  /** Dry-run only: which commit the fake runner blames / flakes on. */
  culprit?: string;
  flaky?: string;
  stepDelayMs: number;
}

export interface ResumeOptions extends CommonOptions {
  command: 'resume';
  runId?: string;
  dryRun?: boolean;
  port: number;
  ui: boolean;
  json: boolean;
  open: boolean;
  flow?: string;
}

export interface InitOptions extends CommonOptions {
  command: 'init';
  /** Accept every default instead of prompting. */
  yes: boolean;
  force: boolean;
  flow?: string;
}

export interface ReportOptions extends CommonOptions {
  command: 'report';
  runId?: string;
  open: boolean;
  out?: string;
  json: boolean;
}

export interface ReplayOptions extends CommonOptions {
  command: 'replay';
  fixture: string;
  speed: number;
  port?: number;
  ui: boolean;
  json: boolean;
  open: boolean;
}

export interface HelpOptions extends CommonOptions {
  command: 'help';
  topic?: Command;
}

export interface VersionOptions extends CommonOptions {
  command: 'version';
}

export type ParsedArgs =
  | RunOptions
  | ResumeOptions
  | InitOptions
  | ReportOptions
  | ReplayOptions
  | HelpOptions
  | VersionOptions;

/** Anything that smells like a credential. Refused with a pointer to env auth. */
const SECRET_FLAGS = [
  'api-key',
  'apikey',
  'key',
  'token',
  'auth-token',
  'access-token',
  'secret',
  'password',
  'revyl-api-key',
  'revyl-key',
  'revyl-token',
];

const COMMANDS: Command[] = ['init', 'run', 'resume', 'report', 'replay', 'help', 'version'];

interface RawArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function tokenize(argv: string[]): RawArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      let name = eq === -1 ? body : body.slice(0, eq);
      let value: string | boolean | undefined = eq === -1 ? undefined : body.slice(eq + 1);

      assertNotSecret(name);

      if (value === undefined) {
        if (name.startsWith('no-')) {
          name = name.slice(3);
          value = false;
        } else {
          const next = argv[i + 1];
          // A flag only swallows the next token when it isn't itself a flag.
          // `--flag -3` stays a boolean; negative numbers arrive via `=`.
          if (next !== undefined && (!next.startsWith('-') || next === '-')) {
            value = next;
            i++;
          } else {
            value = true;
          }
        }
      }
      flags.set(name, value);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const expanded = SHORT_FLAGS[short];
      if (!expanded) throw new CliError(`Unknown option \`-${short}\`.`, { hint: 'Run `mobile-bisect --help`.', exitCode: 2 });
      flags.set(expanded, true);
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

const SHORT_FLAGS: Record<string, string> = {
  h: 'help',
  v: 'version',
  y: 'yes',
};

function assertNotSecret(name: string): void {
  if (!SECRET_FLAGS.includes(name.toLowerCase())) return;
  throw new CliError(`mobile-bisect never accepts credentials on the command line (\`--${name}\`).`, {
    hint: 'Authenticate with the Revyl CLI, or export REVYL_API_KEY in your environment.',
    exitCode: 2,
  });
}

const KNOWN_FLAGS: Record<Command, string[]> = {
  run: [
    'good', 'bad', 'flow', 'expect', 'device-model', 'os-version', 'platform', 'concurrency',
    'max-candidates', 'timeout', 'allow-dirty', 'dry-run', 'port', 'ui', 'json', 'open',
    'culprit', 'flaky', 'step-delay', 'cwd', 'help', 'color',
    'framework', 'scheme', 'variant', 'project-dir',
  ],
  resume: ['cwd', 'dry-run', 'port', 'ui', 'json', 'open', 'flow', 'help', 'color'],
  init: ['cwd', 'yes', 'force', 'flow', 'help', 'color'],
  report: ['cwd', 'open', 'out', 'json', 'help', 'color'],
  replay: ['cwd', 'speed', 'port', 'ui', 'json', 'open', 'help', 'color'],
  help: ['cwd', 'help', 'color'],
  version: ['cwd', 'help', 'color', 'version'],
};

function assertKnownFlags(command: Command, flags: Map<string, string | boolean>): void {
  const known = KNOWN_FLAGS[command];
  for (const name of flags.keys()) {
    if (known.includes(name) || name === 'version') continue;
    const suggestion = nearest(name, known);
    throw new CliError(`Unknown option \`--${name}\` for \`mobile-bisect ${command}\`.`, {
      hint: suggestion
        ? `Did you mean \`--${suggestion}\`?`
        : `Run \`mobile-bisect ${command} --help\` for the supported options.`,
      exitCode: 2,
    });
  }
}

function nearest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 3; // only suggest genuinely close matches
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const cur = [i, ...new Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[cols - 1]!;
}

// --- typed accessors -------------------------------------------------------

function str(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') {
    throw new CliError(`\`--${name}\` needs a value.`, { exitCode: 2 });
  }
  return v;
}

function bool(flags: Map<string, string | boolean>, name: string, fallback: boolean): boolean {
  const v = flags.get(name);
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new CliError(`\`--${name}\` takes no value (got \`${v}\`).`, { exitCode: 2 });
}

function int(
  flags: Map<string, string | boolean>,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') throw new CliError(`\`--${name}\` needs a number.`, { exitCode: 2 });
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CliError(`\`--${name}\` must be a whole number (got \`${raw}\`).`, { exitCode: 2 });
  }
  if (n < range.min || n > range.max) {
    throw new CliError(
      `\`--${name}\` must be between ${range.min} and ${range.max} (got ${n}).`,
      { exitCode: 2 },
    );
  }
  return n;
}

/**
 * Accepts the platform words people actually type. `--framework ios` meaning
 * "build it with Xcode" is the obvious reading, and refusing it to insist on
 * the tool's name would be pedantry.
 */
const FRAMEWORK_ALIASES: Record<string, FrameworkName> = {
  expo: 'expo',
  xcode: 'xcode',
  gradle: 'gradle',
  ios: 'xcode',
  swift: 'xcode',
  swiftui: 'xcode',
  objc: 'xcode',
  android: 'gradle',
  kotlin: 'gradle',
  java: 'gradle',
  'react-native': 'expo',
  rn: 'expo',
  'revyl-remote': 'revyl-remote',
  remote: 'revyl-remote',
  revyl: 'revyl-remote',
  cloud: 'revyl-remote',
};

function frameworkName(value: string | undefined): FrameworkName | undefined {
  if (value === undefined || value.toLowerCase() === 'auto') return undefined;
  const resolved = FRAMEWORK_ALIASES[value.toLowerCase()];
  if (resolved) return resolved;
  throw new CliError(
    `\`--framework\` must be expo, xcode, gradle or revyl-remote (got \`${value}\`).`,
    {
      hint:
        'Aliases: ios/swift -> xcode, android/kotlin -> gradle, remote/cloud -> revyl-remote ' +
        '(builds every candidate on Revyl, no local toolchain). Omit it to detect automatically.',
      exitCode: 2,
    },
  );
}

// --- entry point -----------------------------------------------------------

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  const { flags, positionals } = tokenize(argv);

  if (flags.has('version') && positionals.length === 0) return { command: 'version', cwd };

  const first = positionals[0];
  if (first === undefined) {
    return { command: 'help', cwd };
  }
  if (!COMMANDS.includes(first as Command)) {
    const suggestion = nearest(first, COMMANDS);
    throw new CliError(`Unknown command \`${first}\`.`, {
      hint: suggestion ? `Did you mean \`mobile-bisect ${suggestion}\`?` : 'Run `mobile-bisect --help`.',
      exitCode: 2,
    });
  }

  const command = first as Command;
  const rest = positionals.slice(1);
  assertKnownFlags(command, flags);

  const base: CommonOptions = { cwd: str(flags, 'cwd') ?? cwd };

  if (flags.get('help') === true && command !== 'help') {
    return { command: 'help', topic: command, ...base };
  }

  switch (command) {
    case 'help':
      return { command: 'help', topic: rest[0] as Command | undefined, ...base };

    case 'version':
      return { command: 'version', ...base };

    case 'init':
      return {
        command: 'init',
        yes: bool(flags, 'yes', false),
        force: bool(flags, 'force', false),
        flow: str(flags, 'flow'),
        ...base,
      };

    case 'run': {
      const good = str(flags, 'good');
      const bad = str(flags, 'bad');
      if (!good || !bad) {
        throw new CliError('`mobile-bisect run` needs both `--good <ref>` and `--bad <ref>`.', {
          hint: 'e.g. mobile-bisect run --good v1.4.0 --bad HEAD --flow flows/checkout.yaml',
          exitCode: 2,
        });
      }
      const platform = (str(flags, 'platform') ?? 'ios') as 'ios' | 'android';
      if (platform !== 'ios' && platform !== 'android') {
        throw new CliError(`\`--platform\` must be \`ios\` or \`android\` (got \`${platform}\`).`, {
          exitCode: 2,
        });
      }
      const json = bool(flags, 'json', false);
      return {
        command: 'run',
        good,
        bad,
        flow: str(flags, 'flow'),
        expect: str(flags, 'expect'),
        deviceModel: str(flags, 'device-model'),
        osVersion: str(flags, 'os-version'),
        platform,
        framework: frameworkName(str(flags, 'framework')),
        scheme: str(flags, 'scheme'),
        variant: str(flags, 'variant'),
        projectDir: str(flags, 'project-dir'),
        concurrency: int(flags, 'concurrency', 1, { min: 1, max: 8 }),
        maxCandidates: int(flags, 'max-candidates', 64, { min: 2, max: 4096 }),
        timeoutMs: int(flags, 'timeout', 600, { min: 5, max: 86_400 }) * 1000,
        allowDirty: bool(flags, 'allow-dirty', false),
        dryRun: bool(flags, 'dry-run', false),
        port: int(flags, 'port', 4785, { min: 0, max: 65_535 }),
        ui: bool(flags, 'ui', true) && !json,
        json,
        open: bool(flags, 'open', false),
        culprit: str(flags, 'culprit'),
        flaky: str(flags, 'flaky'),
        stepDelayMs: int(flags, 'step-delay', 12, { min: 0, max: 60_000 }),
        ...base,
      };
    }

    case 'resume': {
      const json = bool(flags, 'json', false);
      return {
        command: 'resume',
        runId: rest[0],
        dryRun: flags.has('dry-run') ? bool(flags, 'dry-run', false) : undefined,
        port: int(flags, 'port', 4785, { min: 0, max: 65_535 }),
        ui: bool(flags, 'ui', true) && !json,
        json,
        open: bool(flags, 'open', false),
        flow: str(flags, 'flow'),
        ...base,
      };
    }

    case 'report':
      return {
        command: 'report',
        runId: rest[0],
        open: bool(flags, 'open', true),
        out: str(flags, 'out'),
        json: bool(flags, 'json', false),
        ...base,
      };

    case 'replay': {
      const fixture = rest[0];
      if (!fixture) {
        throw new CliError('`mobile-bisect replay` needs a path to an events.jsonl fixture.', {
          hint: 'e.g. mobile-bisect replay fixtures/demo-runs/orbit-checkout.jsonl',
          exitCode: 2,
        });
      }
      const json = bool(flags, 'json', false);
      const speed = Number(str(flags, 'speed') ?? '1');
      if (!Number.isFinite(speed) || speed <= 0) {
        throw new CliError('`--speed` must be a positive number.', { exitCode: 2 });
      }
      return {
        command: 'replay',
        fixture,
        speed,
        port: flags.has('port') ? int(flags, 'port', 4785, { min: 0, max: 65_535 }) : undefined,
        ui: bool(flags, 'ui', true) && !json,
        json,
        open: bool(flags, 'open', false),
        ...base,
      };
    }
  }
}

// --- help ------------------------------------------------------------------

const MAIN_HELP = `mobile-bisect, git bisect for visual mobile regressions

USAGE
  mobile-bisect <command> [options]

COMMANDS
  init                    Check the project, verify Revyl auth, write mobile-bisect.config.ts
  run                     Binary-search history for the commit that broke a flow
  resume [run-id]         Continue the latest unfinished run, or a named one
  report [run-id]         Render the static HTML report and open it
  replay <fixture.jsonl>  Drive the live view from a recorded event stream

RUN OPTIONS
  --good <ref>              Last known-good ref (required)
  --bad <ref>               Known-bad ref (required, usually HEAD)
  --flow <path>             Flow YAML to run against every candidate
  --expect <sentence>       Assertion to evaluate; overrides the flow's \`expect\`
  --device-model <name>     Cloud device model, e.g. "iPhone 15 Pro"
  --os-version <version>    Cloud device OS version, e.g. "17.5"
  --platform <ios|android>  Defaults to ios
  --framework <name>        expo | xcode | gradle | revyl-remote. Detected when omitted
  --scheme <name>           Xcode scheme to build (xcode only)
  --variant <name>          Gradle variant to assemble (gradle only, default debug)
  --project-dir <dir>       Subdirectory holding the native project, e.g. ios
  --concurrency <n>         Candidates evaluated in parallel (default 1, max 8)
  --max-candidates <n>      Refuse to start beyond this many commits (default 64)
  --timeout <seconds>       Per-candidate flow timeout (default 600)
  --allow-dirty             Proceed with uncommitted changes; they are never touched
  --dry-run                 Use the built-in fake runner: no cloud, fully offline
  --port <n>                Live view port (default 4785; 0 serves nothing)
  --no-ui                   Plain line-per-event logging instead of the live view
  --json                    Emit the raw event stream as JSON lines on stdout
  --open                    Open the live view in a browser

DRY-RUN OPTIONS
  --culprit <ref>           Commit the fake runner should blame
  --flaky <ref>             Commit the fake runner returns inconclusive once
  --step-delay <ms>         Fake per-step delay (default 12)

COMMON OPTIONS
  --cwd <dir>               Run as if started in <dir>
  --no-color                Disable colour (also honours NO_COLOR)
  -h, --help                Show help
  -v, --version             Show version

EXAMPLES
  mobile-bisect init
  mobile-bisect run --good v1.4.0 --bad HEAD --flow flows/checkout.yaml \\
    --expect "the order confirmation screen appears"
  mobile-bisect run --good v1.4.0 --bad HEAD --flow flows/checkout.yaml --dry-run
  mobile-bisect run --good v1.4.0 --bad HEAD --framework xcode --scheme Orbit
  mobile-bisect run --good v1.4.0 --bad HEAD --framework gradle --platform android
  mobile-bisect resume
  mobile-bisect report

mobile-bisect never accepts an API key as a flag. Authentication comes from your
Revyl CLI session or REVYL_API_KEY in the environment.`;

const COMMAND_HELP: Record<Command, string> = {
  run: `mobile-bisect run: binary-search history for the commit that broke a flow

USAGE
  mobile-bisect run --good <ref> --bad <ref> [--flow <path>] [options]

Every candidate is checked out into a detached worktree; your working tree is
never touched. Ctrl-C stops device sessions, removes the worktrees, and prints
the command to resume.

  --good <ref>              Last known-good ref (required)
  --bad <ref>               Known-bad ref (required, usually HEAD)
  --flow <path>             Flow YAML to run against every candidate
  --expect <sentence>       Assertion to evaluate; overrides the flow's \`expect\`
  --device-model <name>     Cloud device model, e.g. "iPhone 15 Pro"
  --os-version <version>    Cloud device OS version, e.g. "17.5"
  --platform <ios|android>  Defaults to ios
  --framework <name>        expo | xcode | gradle | revyl-remote. Detected when omitted
  --scheme <name>           Xcode scheme to build (xcode only)
  --variant <name>          Gradle variant to assemble (gradle only, default debug)
  --project-dir <dir>       Subdirectory holding the native project, e.g. ios
  --concurrency <n>         Candidates evaluated in parallel (default 1, max 8)
  --max-candidates <n>      Refuse to start beyond this many commits (default 64)
  --timeout <seconds>       Per-candidate flow timeout (default 600)
  --allow-dirty             Proceed with uncommitted changes; they are never touched
  --dry-run                 Use the built-in fake runner: no cloud, fully offline
  --port <n>                Live view port (default 4785; 0 serves nothing)
  --no-ui                   Plain line-per-event logging instead of the live view
  --json                    Emit the raw event stream as JSON lines on stdout
  --open                    Open the live view in a browser
  --culprit <ref>           Dry-run only: commit the fake runner should blame
  --flaky <ref>             Dry-run only: commit that goes inconclusive once
  --step-delay <ms>         Dry-run only: per-step delay (default 12)`,

  init: `mobile-bisect init: set up a project

USAGE
  mobile-bisect init [options]

Checks git, detects the framework, verifies Revyl auth and any prebuilt app, writes
mobile-bisect.config.ts, and validates one flow against the current commit.

  --flow <path>             Flow to validate (defaults to the first flow found)
  --yes, -y                 Accept defaults instead of prompting
  --force                   Overwrite an existing mobile-bisect.config.ts`,

  resume: `mobile-bisect resume: continue an interrupted run

USAGE
  mobile-bisect resume [run-id] [options]

With no run-id, the most recent unfinished run continues. Commits that were
already classified are not re-run.

  --port <n>                Live view port (default 4785; 0 serves nothing)
  --no-ui                   Plain line-per-event logging
  --json                    Emit the raw event stream as JSON lines
  --flow <path>             Override the flow recorded with the run`,

  report: `mobile-bisect report: render the static HTML report

USAGE
  mobile-bisect report [run-id] [options]

  --out <path>              Write somewhere other than <run-dir>/report.html
  --no-open                 Print the path instead of opening a browser
  --json                    Print { runId, reportPath } as JSON`,

  replay: `mobile-bisect replay: drive the live view from a recorded stream

USAGE
  mobile-bisect replay <fixture.jsonl> [options]

  --speed <x>               Playback multiplier (default 1)
  --port <n>                Also serve the live view on this port
  --no-ui                   Plain line-per-event logging
  --json                    Re-emit the stream as JSON lines`,

  help: MAIN_HELP,
  version: MAIN_HELP,
};

export function helpText(topic?: Command): string {
  if (topic && topic !== 'help' && topic !== 'version') return COMMAND_HELP[topic];
  return MAIN_HELP;
}
