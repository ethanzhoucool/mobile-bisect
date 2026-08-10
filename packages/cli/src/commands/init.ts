/**
 * First-run setup: six checks, each pass/fail, nothing hidden.
 *
 * `init` is allowed to create two files (mobile-bisect.config.ts and a starter
 * flow) and nothing else. It never edits a file the user already owns.
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import * as git from '@mobile-bisect/git';
import { loadRunner } from '../adapters.js';
import type { InitOptions } from '../args.js';
import { findConfig, loadConfig, writeConfig, type MobileBisectConfig } from '../config.js';
import { messageOf } from '../errors.js';
import { findFlowFile, loadFlow } from '../flow.js';
import { detectFrameworks, type DetectionSummary, type FrameworkName } from '../frameworks.js';
import { ensureToolDirIgnored } from '../run.js';

type Status = 'pass' | 'warn' | 'fail';

interface Check {
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

const MARK: Record<Status, string> = {
  pass: pc.green('✔'),
  warn: pc.yellow('!'),
  fail: pc.red('✖'),
};

/** Simulator builds we can find without asking. */
const BUILD_DIRS = [
  'build',
  'dist',
  'ios/build/Build/Products/Debug-iphonesimulator',
  'ios/build/Build/Products/Release-iphonesimulator',
  '.mobile-bisect/build',
];

export async function initCommand(opts: InitOptions): Promise<number> {
  const repo = path.resolve(opts.cwd);
  const checks: Check[] = [];

  process.stdout.write(`\n  ${pc.bold('mobile-bisect init')}  ${pc.dim(repo)}\n\n`);

  checks.push(await checkGit(repo));
  const { config } = await loadConfig(repo);
  const framework = await checkFramework(repo, config);
  checks.push(framework.check);
  checks.push(await checkRevyl());

  const build = await checkBuild(repo, config, opts, framework.name);
  checks.push(build.check);

  checks.push(
    await checkConfig(repo, opts, {
      flowPath: undefined,
      build: build.appPath,
      framework: framework.name,
    }),
  );
  const flow = await checkFlow(repo, opts, config);
  checks.push(flow.check);

  // Rewrite the config now that we know where the flow and the build live.
  if (flow.flowPath || build.appPath) {
    await writeConfig(
      repo,
      configFrom(repo, config, {
        flowPath: flow.flowPath,
        appPath: build.appPath,
        expect: flow.expect,
        framework: framework.name,
      }),
      { force: true },
    );
  }
  await ensureToolDirIgnored(repo);

  for (const [i, check] of checks.entries()) {
    process.stdout.write(
      `  ${pc.dim(String(i + 1))}  ${MARK[check.status]}  ${check.label.padEnd(24)}${check.detail}\n`,
    );
    if (check.fix) process.stdout.write(`${' '.repeat(9)}${pc.dim(`↳ ${check.fix}`)}\n`);
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const passed = checks.length - failed - warned;
  const summary = [
    `${passed} passed`,
    warned > 0 ? `${warned} warning${warned === 1 ? '' : 's'}` : '',
    failed > 0 ? pc.red(`${failed} failed`) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  process.stdout.write(`\n  ${pc.dim(summary)}\n\n`);

  if (failed === 0) {
    process.stdout.write(`  ${pc.dim('Try it offline first:')}\n`);
    process.stdout.write(
      `    ${pc.cyan(`mobile-bisect run --good <last-good-ref> --bad HEAD --dry-run`)}\n\n`,
    );
  } else {
    process.stdout.write(`  ${pc.dim('Fix the failures above, then run `mobile-bisect init` again.')}\n\n`);
  }
  return failed === 0 ? 0 : 1;
}

// --- checks ----------------------------------------------------------------

async function checkGit(repo: string): Promise<Check> {
  if (!(await git.isGitRepo(repo))) {
    return {
      label: 'git repository',
      status: 'fail',
      detail: 'not a git repository',
      fix: 'Run mobile-bisect from inside your app repo, or pass --cwd <dir>.',
    };
  }
  try {
    const head = await git.commitMeta(repo, 'HEAD');
    return {
      label: 'git repository',
      status: 'pass',
      detail: `HEAD at ${pc.bold(head.shortSha)} ${pc.dim(head.subject)}`,
    };
  } catch (e) {
    return { label: 'git repository', status: 'warn', detail: messageOf(e) };
  }
}

/**
 * Which adapter will prepare candidates, and what that will cost.
 *
 * Being explicit about the cost here matters: an Expo project bisects in
 * seconds per round, an Xcode or Gradle project in minutes. A user who reads
 * "compiled per candidate" up front is not surprised twenty minutes in.
 */
async function checkFramework(
  repo: string,
  config: MobileBisectConfig,
): Promise<{ check: Check; name?: FrameworkName }> {
  const summary = await detectFrameworks({ projectRoot: repo, config });
  const requested = config.framework && config.framework !== 'auto' ? config.framework : undefined;
  const chosen = requested
    ? summary.considered.find((c) => c.name === requested)
    : summary.picked;

  if (!chosen) {
    return {
      check: {
        label: 'framework',
        status: 'fail',
        detail: requested ? `\`${requested}\` is unavailable` : 'could not tell what kind of app this is',
        fix: firstReason(summary) ?? 'Set `framework` in mobile-bisect.config.ts.',
      },
    };
  }

  if (!chosen.detection.ok) {
    return {
      check: {
        label: 'framework',
        status: 'fail',
        detail: `${chosen.adapter.displayName} — not ready`,
        fix: chosen.detection.reason,
      },
      name: chosen.name,
    };
  }

  const cost =
    chosen.adapter.candidateKind === 'binary'
      ? 'compiled per candidate'
      : 'JavaScript swapped per candidate';
  return {
    check: {
      label: 'framework',
      status: 'pass',
      detail: `${pc.bold(chosen.adapter.displayName)} ${pc.dim(`· ${chosen.detection.summary ?? ''} · ${cost}`)}`,
      fix: requested ? undefined : `Pin it with \`framework: '${chosen.name}'\` if detection ever guesses wrong.`,
    },
    name: chosen.name,
  };
}

function firstReason(summary: DetectionSummary): string | undefined {
  return summary.considered.find((c) => c.detection.reason)?.detection.reason;
}

async function checkRevyl(): Promise<Check> {
  const api = await loadRunner();
  try {
    const auth = await api.checkRevylAuth();
    if (auth.ok) {
      return {
        label: 'Revyl authentication',
        status: 'pass',
        detail: auth.org ? `signed in to ${pc.bold(auth.org)}` : auth.message,
      };
    }
    return {
      label: 'Revyl authentication',
      status: 'warn',
      detail: auth.message,
      fix: 'Log in with the Revyl CLI or export REVYL_API_KEY. `--dry-run` works without it.',
    };
  } catch (e) {
    return { label: 'Revyl authentication', status: 'warn', detail: messageOf(e) };
  }
}

/**
 * Only a bundle-swapping adapter needs a binary up front: it points an
 * already-installed dev client at each candidate's JavaScript, so something has
 * to have installed that dev client. The native adapters compile their own.
 */
async function checkBuild(
  repo: string,
  config: MobileBisectConfig,
  opts: InitOptions,
  framework?: FrameworkName,
): Promise<{ check: Check; appPath?: string }> {
  if (framework === 'xcode' || framework === 'gradle') {
    return {
      check: {
        label: 'app binary',
        status: 'pass',
        detail: pc.dim('built from source for every candidate'),
      },
    };
  }

  const configured = config.build?.appPath;
  if (configured && (await exists(path.resolve(repo, configured)))) {
    return {
      check: { label: 'simulator build', status: 'pass', detail: configured },
      appPath: configured,
    };
  }
  if (config.build?.buildId) {
    return {
      check: { label: 'simulator build', status: 'pass', detail: `EAS build ${config.build.buildId}` },
    };
  }

  const found = await findBuild(repo);
  if (found) {
    return {
      check: {
        label: 'simulator build',
        status: 'pass',
        detail: path.relative(repo, found),
      },
      appPath: path.relative(repo, found),
    };
  }

  const answer = await ask(
    opts,
    `  ${pc.dim('?')} Path to a simulator development build (.app), or Enter to skip: `,
  );
  if (answer) {
    const resolved = path.resolve(repo, answer);
    if (await exists(resolved)) {
      return {
        check: { label: 'simulator build', status: 'pass', detail: path.relative(repo, resolved) },
        appPath: path.relative(repo, resolved),
      };
    }
    return {
      check: {
        label: 'simulator build',
        status: 'warn',
        detail: `nothing at ${answer}`,
        fix: 'Set build.appPath in mobile-bisect.config.ts once the build exists.',
      },
    };
  }

  return {
    check: {
      label: 'simulator build',
      status: 'warn',
      detail: 'none found',
      fix: 'Build one with `eas build --profile development --platform ios --local`, then set build.appPath.',
    },
  };
}

async function checkConfig(
  repo: string,
  opts: InitOptions,
  extra: { flowPath?: string; build?: string; framework?: FrameworkName },
): Promise<Check> {
  const existing = await findConfig(repo);
  if (existing && !opts.force) {
    return {
      label: 'mobile-bisect.config.ts',
      status: 'pass',
      detail: `${path.basename(existing)} ${pc.dim('already present (--force to rewrite)')}`,
    };
  }
  const { config } = await loadConfig(repo);
  const written = await writeConfig(
    repo,
    configFrom(repo, config, {
      flowPath: extra.flowPath,
      appPath: extra.build,
      framework: extra.framework,
    }),
    { force: true },
  );
  return {
    label: 'mobile-bisect.config.ts',
    status: 'pass',
    detail: written.written ? 'written' : 'unchanged',
  };
}

async function checkFlow(
  repo: string,
  opts: InitOptions,
  config: MobileBisectConfig,
): Promise<{ check: Check; flowPath?: string; expect?: string }> {
  let target = opts.flow ?? config.flow;
  let resolved = target ? path.resolve(repo, target) : await findFlowFile(repo);

  if (!resolved) {
    const answer = await ask(
      opts,
      `  ${pc.dim('?')} No flow found. Create flows/checkout.yaml from the example? [Y/n] `,
      'y',
    );
    if (answer.toLowerCase().startsWith('n')) {
      return {
        check: {
          label: 'flow',
          status: 'fail',
          detail: 'no flow file',
          fix: 'Create one (see examples/flows/checkout.yaml) and pass it with --flow.',
        },
      };
    }
    resolved = path.join(repo, 'flows', 'checkout.yaml');
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, await exampleFlow(), 'utf8');
    target = path.relative(repo, resolved);
  }

  try {
    const flow = await loadFlow(resolved);
    const head = await git.resolveRef(repo, 'HEAD').catch(() => '');
    return {
      check: {
        label: 'flow',
        status: 'pass',
        detail:
          `${path.relative(repo, resolved)} ${pc.dim(`· ${flow.steps.length} steps`)}` +
          (head ? pc.dim(` · parsed against ${head.slice(0, 7)}`) : ''),
        fix: flow.expect
          ? undefined
          : 'No `expect:` in the flow — pass --expect on every run, or add one.',
      },
      flowPath: path.relative(repo, resolved),
      expect: flow.expect,
    };
  } catch (e) {
    return {
      check: {
        label: 'flow',
        status: 'fail',
        detail: path.relative(repo, resolved),
        fix: messageOf(e).split('\n')[0],
      },
    };
  }
}

// --- helpers ---------------------------------------------------------------

function configFrom(
  repo: string,
  existing: MobileBisectConfig,
  extra: { flowPath?: string; appPath?: string; expect?: string; framework?: FrameworkName },
): MobileBisectConfig {
  const framework = extra.framework ?? frameworkOf(existing);
  const platform = existing.platform ?? (framework === 'gradle' ? 'android' : 'ios');
  const config: MobileBisectConfig = {
    flow: extra.flowPath ?? existing.flow ?? 'flows/checkout.yaml',
    expect: extra.expect ?? existing.expect,
    ...(framework ? { framework } : {}),
    platform,
    // A pair `revyl device targets` actually offers; a model/runtime combination
    // it does not have is refused at session start, one candidate at a time.
    deviceModel: existing.deviceModel ?? (platform === 'android' ? 'Pixel 7' : 'iPhone 16'),
    osVersion: existing.osVersion ?? (platform === 'android' ? 'Android 14' : 'iOS 18.5'),
    maxCandidates: existing.maxCandidates ?? 64,
  };
  const appPath = extra.appPath ?? existing.build?.appPath;
  const build = { ...existing.build, ...(appPath ? { appPath } : {}) };
  if (Object.values(build).some((v) => v !== undefined)) config.build = build;
  return config;
}

function frameworkOf(config: MobileBisectConfig): FrameworkName | undefined {
  return config.framework && config.framework !== 'auto' ? config.framework : undefined;
}

async function findBuild(repo: string): Promise<string | undefined> {
  for (const dir of BUILD_DIRS) {
    const full = path.join(repo, dir);
    try {
      const entries = await readdir(full);
      const app = entries.find((e) => e.endsWith('.app'));
      if (app) return path.join(full, app);
    } catch {
      // not there — keep looking
    }
  }
  return undefined;
}

async function exampleFlow(): Promise<string> {
  // Ships in the package (see `files` in package.json); dist/ is one level deeper.
  const candidates = [
    new URL('../../examples/flows/checkout.yaml', import.meta.url),
    new URL('../../../examples/flows/checkout.yaml', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return await readFile(fileURLToPath(url), 'utf8');
    } catch {
      // try the next layout
    }
  }
  return FALLBACK_FLOW;
}

const FALLBACK_FLOW = `name: checkout-flow
expect: the order confirmation screen appears

steps:
  - label: Launch the app
    launch:
      resetState: true

  - label: Tap "Place order"
    tap: the "Place order" button

  - label: Assert order confirmation
    assert: the "Order confirmed" heading is visible
`;

async function ask(opts: InitOptions, question: string, fallback = ''): Promise<string> {
  if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function firstExisting(repo: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await exists(path.join(repo, name))) return name;
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
