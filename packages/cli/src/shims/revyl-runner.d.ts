/** Compile-time shim for `@mobile-bisect/revyl-runner`. See src/shims/core.d.ts. */

import type {
  Artifacts,
  LaunchInput,
  MobileRuntimeRunner,
  RunFlowInput,
  RunResult,
  Session,
  StartSessionInput,
} from '@mobile-bisect/core';

/**
 * Options are passed through from the CLI. Credentials are never part of this
 * object — the runner reads the Revyl CLI session or REVYL_API_KEY itself.
 */
export interface RevylRunnerOptions {
  deviceModel?: string;
  osVersion?: string;
  platform?: 'ios' | 'android';
  buildId?: string;
  appId?: string;
  projectRoot?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export declare class RevylRunner implements MobileRuntimeRunner {
  constructor(opts: RevylRunnerOptions);
  startSession(input: StartSessionInput): Promise<Session>;
  installOrLaunch(input: LaunchInput): Promise<void>;
  runFlow(input: RunFlowInput): Promise<RunResult>;
  collectArtifacts(runId: string): Promise<Artifacts>;
  stopSession(sessionId: string): Promise<void>;
}

export declare function checkRevylAuth(): Promise<{ ok: boolean; org?: string; message: string }>;
