export { RevylRunner, type RevylRunnerOptions } from './runner.js';
export {
  RevylRemoteAdapter,
  platformsIn,
  type RevylRemoteAdapterOptions,
} from './remote-adapter.js';
export { checkRevylAuth, type RevylAuthCheck } from './auth.js';
export { resolveRevylCli, createExecutor, type CliExecutor, type CliResult } from './exec.js';
export { RevylError, RevylInfraError, RevylAuthError, UnsupportedStepError } from './errors.js';
export { classify, isInfraFailure, type Classification, type ClassifyInput } from './classify.js';
export {
  downloadAll,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  type DownloadJob,
  type DownloadOptions,
  type DownloadOutcome,
  type FetchLike,
} from './download.js';
export { redactString, redactValue, redactWithEnv, redactError, REDACTED } from './redact.js';
export * as cliAdapter from './cli-adapter.js';
export type { ReportFrame, SessionInfo, SessionReport, StepOutcome } from './cli-adapter.js';
