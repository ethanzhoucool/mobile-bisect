/**
 * Runtime adapter for the two optional sibling packages.
 *
 * `@mobile-bisect/core` and `@mobile-bisect/git` are hard dependencies and are
 * imported directly wherever they are used. `report` and `revyl-runner` are
 * not: a report can be rendered by the built-in fallback, and cloud devices are
 * simply unavailable without the runner. Both are loaded lazily so a missing or
 * unbuilt package degrades instead of crashing the CLI at import time.
 */

import type { FlowDefinition, MobileRuntimeRunner } from '@mobile-bisect/core';

export type ApiSource = 'package' | 'builtin';

export interface ReportApi {
  source: ApiSource;
  renderReport(opts: {
    runDir: string;
    outPath?: string;
    /** Both off for --dry-run: the fake runner's artifact URLs are synthetic. */
    allowRemoteMedia?: boolean;
    inlineAssets?: boolean;
  }): Promise<string>;
  serve(opts: {
    runDir: string;
    port?: number;
    open?: boolean;
  }): Promise<{ url: string; close(): Promise<void> }>;
}

export interface RevylRunnerInput {
  deviceModel?: string;
  osVersion?: string;
  platform?: 'ios' | 'android';
  buildId?: string;
  appId?: string;
  projectRoot?: string;
  timeoutMs?: number;
  flow?: FlowDefinition;
  /**
   * Where captured frames land. Without these the runner writes nothing to
   * disk, and the presigned URLs expire long before the report renders, so
   * both must be passed for the evidence view to survive.
   */
  runDir?: string;
  artifactsDir?: string;
}

export interface RunnerApi {
  source: ApiSource;
  createRevylRunner(opts: RevylRunnerInput): MobileRuntimeRunner;
  checkRevylAuth(): Promise<{ ok: boolean; org?: string; message: string }>;
}

/** Set MOBILE_BISECT_FALLBACK=1 to ignore the optional packages entirely. */
const FORCE_FALLBACK = process.env.MOBILE_BISECT_FALLBACK === '1';

async function tryImport(specifier: string): Promise<Record<string, unknown> | null> {
  if (FORCE_FALLBACK) return null;
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function has(mod: Record<string, unknown> | null, names: string[]): boolean {
  return !!mod && names.every((n) => typeof mod[n] === 'function');
}

let reportPromise: Promise<ReportApi> | undefined;

export function loadReport(): Promise<ReportApi> {
  reportPromise ??= (async (): Promise<ReportApi> => {
    const mod = await tryImport('@mobile-bisect/report');
    if (has(mod, ['renderReport', 'serve'])) {
      return { source: 'package', ...(mod as unknown as Omit<ReportApi, 'source'>) };
    }
    const builtin = await import('./fallback/report.js');
    return { source: 'builtin', ...builtin };
  })();
  return reportPromise;
}

let runnerPromise: Promise<RunnerApi> | undefined;

export function loadRunner(): Promise<RunnerApi> {
  runnerPromise ??= (async (): Promise<RunnerApi> => {
    const mod = await tryImport('@mobile-bisect/revyl-runner');
    if (has(mod, ['RevylRunner', 'checkRevylAuth'])) {
      const m = mod as unknown as {
        RevylRunner: new (opts: RevylRunnerInput) => MobileRuntimeRunner;
        checkRevylAuth(): Promise<{ ok: boolean; org?: string; message: string }>;
      };
      return {
        source: 'package',
        createRevylRunner: (opts) => new m.RevylRunner(opts),
        checkRevylAuth: () => m.checkRevylAuth(),
      };
    }
    return {
      source: 'builtin',
      createRevylRunner: () => {
        throw new MissingRunnerError();
      },
      checkRevylAuth: async () => ({
        ok: false,
        message:
          '@mobile-bisect/revyl-runner is not installed, so cloud devices are unavailable. `--dry-run` still works offline.',
      }),
    };
  })();
  return runnerPromise;
}

export class MissingRunnerError extends Error {
  constructor() {
    super('Cloud devices need @mobile-bisect/revyl-runner, which is not installed.');
    this.name = 'MissingRunnerError';
  }
}

/** Test seam: forget the cached modules. */
export function resetAdapters(): void {
  reportPromise = undefined;
  runnerPromise = undefined;
}
