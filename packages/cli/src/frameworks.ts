/**
 * Which adapter prepares this repo's candidates.
 *
 * Adapters live in optional sibling packages, loaded lazily the same way the
 * report and the runner are: a repo that never touches Xcode should not pay for
 * the Xcode adapter, and a missing package should degrade with a sentence
 * rather than crash at import time.
 *
 * Detection asks every available adapter and takes the most confident answer.
 * The scores are deliberate — an Expo app that has been prebuilt has `ios/` and
 * `android/` directories too, and swapping its JavaScript is seconds where
 * rebuilding it is minutes, so Expo outranks both native adapters on a project
 * that is genuinely both. `revyl-remote` scores below everything: building in
 * the cloud is the right answer when there is no toolchain on this machine, not
 * the default when there is.
 */

import type {
  AdapterDetection,
  FrameworkAdapter,
  PrepareContext,
  PreparedCandidate,
} from '@mobile-bisect/core';
import { FakeAdapter } from '@mobile-bisect/core';
import type { FrameworkName } from './args.js';
import { CliError } from './errors.js';
import type { MobileBisectConfig } from './config.js';

export const FRAMEWORK_NAMES: FrameworkName[] = ['expo', 'xcode', 'gradle', 'revyl-remote'];

export interface AdapterFactoryInput {
  /** The user's repo root. */
  projectRoot: string;
  config: MobileBisectConfig;
  onLog?: (line: string) => void;
}

export interface DetectedFramework {
  name: FrameworkName;
  adapter: FrameworkAdapter;
  detection: AdapterDetection;
}

/** A framework whose package could not be loaded, kept so `init` can say so. */
export interface UnavailableFramework {
  name: FrameworkName;
  reason: string;
}

export interface DetectionSummary {
  /** Highest-confidence adapter that said `ok`, if any. */
  picked?: DetectedFramework;
  /** Every adapter that loaded, with its verdict, best first. */
  considered: DetectedFramework[];
  unavailable: UnavailableFramework[];
}

const PACKAGE_FOR: Record<FrameworkName, string> = {
  expo: '@mobile-bisect/expo-runner',
  xcode: '@mobile-bisect/native-runner',
  gradle: '@mobile-bisect/native-runner',
  'revyl-remote': '@mobile-bisect/revyl-runner',
};

const EXPORT_FOR: Record<FrameworkName, string> = {
  expo: 'ExpoAdapter',
  xcode: 'XcodeAdapter',
  gradle: 'GradleAdapter',
  'revyl-remote': 'RevylRemoteAdapter',
};

type AdapterCtor = new (opts: Record<string, unknown>) => FrameworkAdapter;

/** Set MOBILE_BISECT_FALLBACK=1 to ignore the optional packages entirely. */
const FORCE_FALLBACK = (): boolean => process.env.MOBILE_BISECT_FALLBACK === '1';

async function loadCtor(name: FrameworkName): Promise<AdapterCtor | string> {
  const specifier = PACKAGE_FOR[name];
  if (FORCE_FALLBACK()) return `${specifier} was skipped (MOBILE_BISECT_FALLBACK=1).`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch {
    return `${specifier} is not installed.`;
  }
  const ctor = mod[EXPORT_FOR[name]];
  if (typeof ctor !== 'function') {
    return `${specifier} does not export ${EXPORT_FOR[name]}.`;
  }
  return ctor as AdapterCtor;
}

/**
 * Adapter options come from three places, most specific first: the flags on
 * this run, the `build` block in the config, and the adapter's own defaults.
 */
function optionsFor(name: FrameworkName, input: AdapterFactoryInput): Record<string, unknown> {
  const { projectRoot, config, onLog } = input;
  const build = config.build ?? {};
  const common = {
    projectRoot,
    ...(onLog ? { onLog } : {}),
    ...(build.timeout ? { buildTimeoutMs: build.timeout * 1000 } : {}),
  };

  switch (name) {
    case 'expo':
      return { ...common, ...(build.timeout ? { readyTimeoutMs: build.timeout * 1000 } : {}) };
    case 'xcode':
      return {
        ...common,
        ...pick(build, ['projectDir', 'workspace', 'project', 'scheme', 'configuration', 'sdk', 'destination']),
      };
    case 'gradle':
      return { ...common, ...pick(build, ['projectDir', 'module', 'variant', 'task']) };
    case 'revyl-remote':
      return {
        projectRoot,
        ...(onLog ? { onLog } : {}),
        ...(build.image ? { image: build.image } : {}),
        ...(build.timeout ? { buildTimeoutSec: build.timeout } : {}),
      };
  }
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
  return out;
}

/** Instantiates one adapter by name, or explains why it cannot be. */
export async function createAdapter(
  name: FrameworkName,
  input: AdapterFactoryInput,
): Promise<FrameworkAdapter> {
  const ctor = await loadCtor(name);
  if (typeof ctor === 'string') {
    throw new CliError(`The \`${name}\` framework adapter is unavailable: ${ctor}`, {
      hint: `Install ${PACKAGE_FOR[name]}, or run with --dry-run to search offline.`,
    });
  }
  return new ctor(optionsFor(name, input));
}

export async function detectFrameworks(input: AdapterFactoryInput): Promise<DetectionSummary> {
  const considered: DetectedFramework[] = [];
  const unavailable: UnavailableFramework[] = [];

  for (const name of FRAMEWORK_NAMES) {
    const ctor = await loadCtor(name);
    if (typeof ctor === 'string') {
      unavailable.push({ name, reason: ctor });
      continue;
    }
    const adapter = new ctor(optionsFor(name, input));
    const detection = await adapter
      .detect(input.projectRoot)
      .catch((err: unknown): AdapterDetection => ({
        ok: false,
        confidence: 0,
        platforms: [],
        reason: err instanceof Error ? err.message : String(err),
      }));
    considered.push({ name, adapter, detection });
  }

  considered.sort((a, b) => score(b) - score(a));
  const picked = considered.find((c) => c.detection.ok);
  return { ...(picked ? { picked } : {}), considered, unavailable };
}

/** An adapter that said no never outranks one that said yes, whatever its score. */
function score(c: DetectedFramework): number {
  return (c.detection.ok ? 1 : 0) + c.detection.confidence;
}

/**
 * Picks the adapter for a run: the requested one, or the detected one.
 *
 * An explicit `--framework` is obeyed even when detection disagrees — the user
 * may be pointing at a project layout we do not recognise — but a failed
 * detection is still reported, because it usually names the real problem
 * (no shared scheme, no `:app` module).
 */
export async function resolveAdapter(
  requested: FrameworkName | undefined,
  input: AdapterFactoryInput,
): Promise<DetectedFramework> {
  if (requested) {
    const adapter = await createAdapter(requested, input);
    const detection = await adapter.detect(input.projectRoot);
    return { name: requested, adapter, detection };
  }

  const summary = await detectFrameworks(input);
  if (summary.picked) return summary.picked;

  throw new CliError('Could not tell what kind of mobile app this is.', {
    hint: explainNoMatch(summary),
  });
}

export function explainNoMatch(summary: DetectionSummary): string {
  const lines: string[] = [];
  for (const c of summary.considered) {
    if (c.detection.reason) lines.push(`  ${c.name}: ${c.detection.reason}`);
  }
  for (const u of summary.unavailable) lines.push(`  ${u.name}: ${u.reason}`);
  lines.push('');
  lines.push(
    'Set `framework` in mobile-bisect.config.ts, or pass --framework expo|xcode|gradle|revyl-remote.',
  );
  return lines.join('\n');
}

/**
 * The dry-run adapter. `--dry-run` must work with no toolchain and no cloud, so
 * it prepares nothing and reports the candidate shape the real adapter would
 * have produced.
 */
export function createFakeAdapter(kind: 'bundle' | 'binary' = 'bundle'): FrameworkAdapter {
  return new FakeAdapter({ candidateKind: kind, displayName: 'Dry run (no build)' });
}

export type { FrameworkAdapter, FrameworkName, PrepareContext, PreparedCandidate };
