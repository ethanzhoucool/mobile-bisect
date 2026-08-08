/**
 * Every fact about the Revyl CLI lives here: argv construction and response
 * parsing, nothing else. `runner.ts` reads as plain orchestration because this
 * module absorbs the CLI's shape — and when the CLI changes, only this file and
 * `fixtures/` move.
 *
 * Shapes below were captured from Revyl CLI v0.1.71 (see `fixtures/`), not from
 * the published docs, which document flags only and no output schemas.
 */

import type { FlowStep } from '@expo-bisect/core';
import type { CliResult } from './exec.js';
import { UnsupportedStepError } from './errors.js';

// ---------------------------------------------------------------------------
// argv builders — pure, and always arrays so nothing is ever shell-interpolated
// ---------------------------------------------------------------------------

/** `-s <index>` targets a session positionally; `-1` means "the active one". */
export type SessionTarget = { index: number } | undefined;

function withTarget(args: string[], target: SessionTarget): string[] {
  if (target && Number.isInteger(target.index) && target.index >= 0) {
    return [...args, '-s', String(target.index)];
  }
  return args;
}

export function authStatusArgs(): string[] {
  return ['auth', 'status', '--json'];
}

export interface StartSessionArgs {
  platform: 'ios' | 'android';
  deviceModel?: string;
  osVersion?: string;
  appId?: string;
  buildId?: string;
  /** Device idle timeout in seconds. */
  idleTimeoutSec?: number;
}

export function deviceStartArgs(o: StartSessionArgs): string[] {
  // `--open` defaults to true and would pop a browser tab per candidate.
  const args = ['device', 'start', '--json', '--open=false', '--platform', o.platform];
  if (o.deviceModel) args.push('--device-model', o.deviceModel);
  if (o.osVersion) args.push('--os-version', o.osVersion);
  if (o.buildId) args.push('--build-version-id', o.buildId);
  else if (o.appId) args.push('--app-id', o.appId);
  if (o.idleTimeoutSec) args.push('--timeout', String(Math.round(o.idleTimeoutSec)));
  return args;
}

export function deviceListArgs(): string[] {
  return ['device', 'list', '--json'];
}

export function deviceInfoArgs(target: SessionTarget): string[] {
  return withTarget(['device', 'info', '--json'], target);
}

export function deviceStopArgs(target: SessionTarget): string[] {
  return withTarget(['device', 'stop', '--json'], target);
}

export function deviceInstallArgs(
  o: { buildId?: string; appId?: string; appUrl?: string; bundleId?: string },
  target: SessionTarget,
): string[] {
  const args = ['device', 'install', '--json'];
  if (o.buildId) args.push('--build-version-id', o.buildId);
  else if (o.appUrl) args.push('--app-url', o.appUrl);
  else if (o.appId) args.push('--app-id', o.appId);
  else throw new UnsupportedStepError('device install needs one of buildId, appId or appUrl');
  if (o.bundleId) args.push('--bundle-id', o.bundleId);
  return withTarget(args, target);
}

export function deviceLaunchArgs(bundleId: string, target: SessionTarget): string[] {
  return withTarget(['device', 'launch', '--json', '--bundle-id', bundleId], target);
}

export function deviceKillAppArgs(target: SessionTarget): string[] {
  return withTarget(['device', 'kill-app', '--json'], target);
}

/**
 * The JS swap. Opening the candidate's dev-client deep link makes the already
 * installed dev client fetch that candidate's bundle — no native rebuild.
 */
export function deviceNavigateArgs(url: string, target: SessionTarget): string[] {
  return withTarget(['device', 'navigate', '--json', '--url', url], target);
}

export function deviceScreenshotArgs(outPath: string, target: SessionTarget): string[] {
  return withTarget(['device', 'screenshot', '--json', '--out', outPath], target);
}

export function deviceValidationArgs(assertion: string, target: SessionTarget): string[] {
  return withTarget(['device', 'validation', assertion, '--json'], target);
}

/**
 * `--no-follow` is mandatory: `device logs` streams forever by default and
 * would hang the bisect. Logs are only readable while the session is alive.
 */
export function deviceLogsArgs(target: SessionTarget): string[] {
  return withTarget(['device', 'logs', '--no-follow', '--json'], target);
}

export function deviceReportArgs(o: {
  sessionId: string;
  artifact?: 'perf' | 'network' | 'trace';
  download?: boolean;
  output?: string;
}): string[] {
  const args = ['device', 'report', '--json', '--session-id', o.sessionId];
  if (o.artifact) args.push('--artifact', o.artifact);
  if (o.download) args.push('--download');
  if (o.output) args.push('--output', o.output);
  return args;
}

/**
 * `revyl run …` inspects a *test* run by task_id. Verified against v0.1.71: it
 * rejects a device session's `workflow_run_id` ("no report found for task …")
 * both during and after the session, so this runner does not use it. Kept
 * exported for the `revyl test run` path a future runner may take.
 */
export function runLogsArgs(taskId: string, o: { download?: boolean; output?: string } = {}): string[] {
  const args = ['run', 'logs', taskId, '--json'];
  if (o.download) args.push('--download');
  if (o.output) args.push('--output', o.output);
  return args;
}

export function runNetworkArgs(taskId: string, o: { download?: boolean; output?: string } = {}): string[] {
  const args = ['run', 'network', taskId, '--json'];
  if (o.download) args.push('--download');
  if (o.output) args.push('--output', o.output);
  return args;
}

export function runTraceArgs(taskId: string, output?: string): string[] {
  const args = ['run', 'trace', taskId];
  if (output) args.push('--output', output);
  return args;
}

// ---------------------------------------------------------------------------
// Flow step -> argv
// ---------------------------------------------------------------------------

/** Low-level device verbs a flow may drive directly, keyed by `step_type`. */
const MANUAL_STEP_TYPES = new Set([
  'wait',
  'navigate',
  'kill_app',
  'go_home',
  'open_app',
  'tap',
  'double_tap',
  'long_press',
  'type',
  'swipe',
  'clear_text',
  'back',
  'key',
  'shake',
  'set_location',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Maps one `FlowStep` to a Revyl CLI invocation.
 *
 * Accepts the Revyl-native block vocabulary (`instructions` / `validation` /
 * `extraction` / `manual`) so a flow authored with `revyl test create` can be
 * pasted straight into a bisect flow file.
 */
export function stepArgs(step: FlowStep, target: SessionTarget): { argv: string[]; kind: 'action' | 'assertion' } {
  const type = String(step.type ?? 'instructions').toLowerCase();
  const description = str(step.step_description) ?? str(step.description) ?? str(step.label);

  if (type === 'instructions' || type === 'instruction') {
    if (!description) throw new UnsupportedStepError(`Step "${step.label}" needs a step_description.`);
    return { argv: withTarget(['device', 'instruction', description, '--json'], target), kind: 'action' };
  }

  if (type === 'validation') {
    if (!description) throw new UnsupportedStepError(`Step "${step.label}" needs a step_description.`);
    return { argv: deviceValidationArgs(description, target), kind: 'assertion' };
  }

  if (type === 'extraction' || type === 'extract') {
    if (!description) throw new UnsupportedStepError(`Step "${step.label}" needs a step_description.`);
    const argv = ['device', 'extract', description, '--json'];
    const varName = str(step.variable_name);
    if (varName) argv.push('--variable-name', varName);
    return { argv: withTarget(argv, target), kind: 'action' };
  }

  if (type === 'manual') {
    const stepType = String(step.step_type ?? '').toLowerCase();
    if (!MANUAL_STEP_TYPES.has(stepType)) {
      throw new UnsupportedStepError(
        `Step "${step.label}": unsupported manual step_type "${stepType}". ` +
          `Supported: ${[...MANUAL_STEP_TYPES].sort().join(', ')}.`,
      );
    }
    return { argv: withTarget(manualArgs(step, stepType, description), target), kind: 'action' };
  }

  // `if` / `while` are server-side test constructs; a raw device session has no
  // interpreter for them, so refuse rather than silently skip.
  throw new UnsupportedStepError(
    `Step "${step.label}": block type "${type}" is not supported by the device-session runner. ` +
      `Use instructions, validation, extraction or manual.`,
  );
}

function manualArgs(step: FlowStep, stepType: string, description: string | undefined): string[] {
  const target = str(step.target);
  const x = typeof step.x === 'number' ? String(step.x) : undefined;
  const y = typeof step.y === 'number' ? String(step.y) : undefined;

  const pointer = (verb: string, extra: string[] = []): string[] => {
    const argv = ['device', verb, '--json', ...extra];
    if (target) argv.push('--target', target);
    else if (x !== undefined && y !== undefined) argv.push('--x', x, '--y', y);
    else throw new UnsupportedStepError(`Step "${step.label}" needs a target or x/y coordinates.`);
    return argv;
  };

  switch (stepType) {
    case 'wait': {
      // Revyl YAML expresses waits in seconds; the CLI flag is milliseconds.
      const seconds = Number(description ?? step.seconds ?? 1);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new UnsupportedStepError(`Step "${step.label}": wait needs a non-negative number of seconds.`);
      }
      return ['device', 'wait', '--json', '--duration-ms', String(Math.round(seconds * 1000))];
    }
    case 'navigate': {
      const url = str(step.url) ?? description;
      if (!url) throw new UnsupportedStepError(`Step "${step.label}": navigate needs a url.`);
      return ['device', 'navigate', '--json', '--url', url];
    }
    case 'kill_app':
      return ['device', 'kill-app', '--json'];
    case 'go_home':
      return ['device', 'home', '--json'];
    case 'open_app': {
      const bundleId = str(step.bundle_id) ?? description;
      if (!bundleId) throw new UnsupportedStepError(`Step "${step.label}": open_app needs a bundle id.`);
      return ['device', 'launch', '--json', '--bundle-id', bundleId];
    }
    case 'back':
      return ['device', 'back', '--json'];
    case 'shake':
      return ['device', 'shake', '--json'];
    case 'key': {
      const key = str(step.key) ?? description;
      if (!key) throw new UnsupportedStepError(`Step "${step.label}": key needs ENTER or BACKSPACE.`);
      return ['device', 'key', '--json', '--key', key.toUpperCase()];
    }
    case 'set_location': {
      // Revyl YAML carries "lat,lon" in step_description; the CLI wants two flags.
      const raw = str(step.coordinates) ?? description ?? '';
      const [lat, lon] = raw.split(',').map((n) => Number(n.trim()));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new UnsupportedStepError(`Step "${step.label}": set_location needs "lat,lon".`);
      }
      return ['device', 'set-location', '--json', '--lat', String(lat), '--lon', String(lon)];
    }
    case 'tap':
      return pointer('tap');
    case 'double_tap':
      return pointer('double-tap');
    case 'clear_text':
      return pointer('clear-text');
    case 'long_press':
      return pointer('long-press', typeof step.duration === 'number' ? ['--duration', String(step.duration)] : []);
    case 'type': {
      const text = str(step.text) ?? description;
      if (text === undefined) throw new UnsupportedStepError(`Step "${step.label}": type needs text.`);
      return pointer('type', ['--text', text]);
    }
    case 'swipe': {
      const direction = str(step.direction);
      if (!direction) throw new UnsupportedStepError(`Step "${step.label}": swipe needs a direction.`);
      return pointer('swipe', ['--direction', direction.toLowerCase()]);
    }
    /* c8 ignore next */
    default:
      throw new UnsupportedStepError(`Step "${step.label}": unhandled manual step_type "${stepType}".`);
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseJson(res: CliResult): unknown {
  const text = res.stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // The CLI occasionally prefixes progress lines; take the last JSON value.
    const start = text.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return undefined;
    }
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface AuthStatus {
  ok: boolean;
  org?: string;
  email?: string;
  message: string;
}

export function parseAuthStatus(res: CliResult): AuthStatus {
  const json = rec(parseJson(res));
  if (!json) {
    const detail = res.stderr.trim() || res.spawnError || `revyl auth status exited ${res.code}`;
    return { ok: false, message: `Could not read Revyl auth status: ${detail}` };
  }
  const authenticated = json.authenticated === true && json.expired !== true;
  const org = str(json.org_name) ?? str(json.org_id);
  const email = str(json.email);
  return {
    ok: authenticated,
    ...(org ? { org } : {}),
    ...(email ? { email } : {}),
    message: authenticated
      ? `Authenticated as ${email ?? 'unknown user'}${org ? ` (org: ${org})` : ''}.`
      : 'Not authenticated. Run `revyl auth login`, or set REVYL_API_KEY.',
  };
}

/** The session envelope returned by `device start` / `device info` / `device list`. */
export interface SessionInfo {
  index: number;
  sessionId: string;
  /** The id `revyl run <task_id>` accepts for this session's artifacts. */
  workflowRunId?: string;
  viewerUrl?: string;
  whepUrl?: string;
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
}

function toSessionInfo(v: unknown): SessionInfo | undefined {
  const o = rec(v);
  const sessionId = o && str(o.session_id);
  if (!o || !sessionId) return undefined;
  return {
    index: typeof o.index === 'number' ? o.index : -1,
    sessionId,
    ...(str(o.workflow_run_id) ? { workflowRunId: str(o.workflow_run_id)! } : {}),
    ...(str(o.viewer_url) ? { viewerUrl: str(o.viewer_url)! } : {}),
    ...(str(o.whep_url) ? { whepUrl: str(o.whep_url)! } : {}),
    ...(str(o.platform) ? { platform: str(o.platform)! } : {}),
    ...(typeof o.screen_width === 'number' ? { screenWidth: o.screen_width } : {}),
    ...(typeof o.screen_height === 'number' ? { screenHeight: o.screen_height } : {}),
  };
}

export function parseSessionInfo(res: CliResult): SessionInfo | undefined {
  return toSessionInfo(parseJson(res));
}

export function parseSessionList(res: CliResult): SessionInfo[] {
  const json = parseJson(res);
  if (!Array.isArray(json)) return [];
  return json.map(toSessionInfo).filter((s): s is SessionInfo => Boolean(s));
}

/**
 * One executed step.
 *
 * The distinction that keeps a bisect honest lives in two fields: `status` is
 * the *worker's* health ("did the step machinery run?") while
 * `validationResult` is the *app's* answer. `status === 'success'` with
 * `validationResult === false` is a real failing assertion, not a broken device.
 */
export interface StepOutcome {
  /** CLI exit code was 0. */
  ok: boolean;
  /** We got a parseable envelope back, so the worker was reachable. */
  workerResponded: boolean;
  success?: boolean;
  status?: string;
  statusReason?: string;
  reasoning?: string;
  validationResult?: boolean | null;
  sessionId?: string;
  workflowRunId?: string;
  stepId?: string;
  /** Base64 PNG of the screen at the end of the step, when the worker returns one. */
  imageBase64?: string;
  code: number;
  timedOut: boolean;
  stderr: string;
  spawnError?: string;
}

export function parseStepOutcome(res: CliResult): StepOutcome {
  const json = rec(parseJson(res));
  const out = rec(json?.step_output);
  const validation = out?.validation_result;

  return {
    ok: res.code === 0,
    workerResponded: Boolean(json),
    ...(typeof json?.success === 'boolean' ? { success: json.success } : {}),
    ...(str(out?.status) ? { status: str(out?.status)! } : {}),
    ...(str(out?.status_reason) ? { statusReason: str(out?.status_reason)! } : {}),
    ...(str(out?.reasoning) ? { reasoning: str(out?.reasoning)! } : {}),
    ...(typeof validation === 'boolean' || validation === null ? { validationResult: validation } : {}),
    ...(str(json?.session_id) ? { sessionId: str(json?.session_id)! } : {}),
    ...(str(json?.workflow_run_id) ? { workflowRunId: str(json?.workflow_run_id)! } : {}),
    ...(str(json?.step_id) ? { stepId: str(json?.step_id)! } : {}),
    ...(str(out?.image) ? { imageBase64: str(out?.image)! } : {}),
    code: res.code,
    timedOut: res.timedOut,
    stderr: res.stderr.trim(),
    ...(res.spawnError ? { spawnError: res.spawnError } : {}),
  };
}

/** One presigned frame, carrying enough position to rebuild execution order. */
export interface ReportFrame {
  /** 1-based step position in execution order. */
  step: number;
  /** 0-based action index within that step. */
  action: number;
  kind: 'before' | 'after';
  url: string;
}

/**
 * Sorts lexicographically into execution order, which is what makes the frame
 * sequence recoverable from a directory listing alone.
 */
export function frameFilename(frame: ReportFrame): string {
  const step = String(frame.step).padStart(2, '0');
  const action = String(frame.action).padStart(2, '0');
  return `step-${step}-action-${action}-${frame.kind}.png`;
}

export interface SessionReport {
  reportUrl?: string;
  deviceModel?: string;
  osVersion?: string;
  whepUrl?: string;
  sessionStatus?: string;
  /** Presigned S3 frames, before + after each grounded action, in step order. */
  frames: ReportFrame[];
  /** The same URLs, flattened — what `Artifacts.screenshots` carries. */
  screenshotUrls: string[];
}

export function parseSessionReport(res: CliResult): SessionReport | undefined {
  const json = rec(parseJson(res));
  if (!json) return undefined;

  const frames: ReportFrame[] = [];
  const steps = (Array.isArray(json.steps) ? json.steps : [])
    .map((s, i) => ({ step: rec(s), order: num(rec(s)?.execution_order) ?? i }))
    .sort((a, b) => a.order - b.order);

  for (const [i, entry] of steps.entries()) {
    const actions = entry.step?.actions;
    if (!Array.isArray(actions)) continue;
    const sorted = actions
      .map((a, j) => ({ action: rec(a), index: num(rec(a)?.action_index) ?? j }))
      .sort((a, b) => a.index - b.index);

    for (const { action, index } of sorted) {
      const at = (kind: 'before' | 'after', url: string): ReportFrame => ({
        step: i + 1,
        action: index,
        kind,
        url,
      });
      const before = action && str(action.screenshot_before_url);
      const after = action && str(action.screenshot_after_url);
      if (before) frames.push(at('before', before));
      if (after) frames.push(at('after', after));
    }
  }

  return {
    ...(str(json.report_url) ? { reportUrl: str(json.report_url)! } : {}),
    ...(str(json.device_model) ? { deviceModel: str(json.device_model)! } : {}),
    ...(str(json.os_version) ? { osVersion: str(json.os_version)! } : {}),
    ...(str(json.whep_url) ? { whepUrl: str(json.whep_url)! } : {}),
    ...(str(json.session_status) ? { sessionStatus: str(json.session_status)! } : {}),
    frames,
    screenshotUrls: frames.map((f) => f.url),
  };
}

/** `--artifact <k>` without `--download` prints the artifact's presigned URL. */
export function parseArtifactUrl(res: CliResult): string | undefined {
  const json = parseJson(res);
  if (typeof json === 'string' && /^https?:\/\//.test(json)) return json;
  const o = rec(json);
  for (const key of ['url', 'artifact_url', 'download_url', 'signed_url', 'presigned_url']) {
    const v = o && str(o[key]);
    if (v) return v;
  }
  const match = res.stdout.match(/https?:\/\/\S+/);
  return match ? match[0] : undefined;
}
