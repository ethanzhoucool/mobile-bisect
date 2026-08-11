/**
 * Auth is never handled by this package, it is only *checked*.
 *
 * We never take a key as an argument, never put one on a command line, and
 * never write one anywhere. The Revyl CLI reads `~/.revyl/credentials.json` or
 * `REVYL_API_KEY` from the inherited environment; all we do is ask it whether
 * that worked, so a bisect fails in the first second instead of on commit 4.
 */

import { authStatusArgs, parseAuthStatus } from './cli-adapter.js';
import { RevylError } from './errors.js';
import { createExecutor, resolveRevylCli, type CliExecutor } from './exec.js';
import { redactWithEnv } from './redact.js';

export interface RevylAuthCheck {
  ok: boolean;
  org?: string;
  message: string;
}

export async function checkRevylAuth(opts: { cliPath?: string; executor?: CliExecutor } = {}): Promise<RevylAuthCheck> {
  let exec = opts.executor;
  if (!exec) {
    try {
      exec = createExecutor({ cliPath: await resolveRevylCli(opts.cliPath) });
    } catch (err) {
      const message = err instanceof RevylError ? err.message : redactWithEnv(String(err));
      return { ok: false, message };
    }
  }

  const status = parseAuthStatus(await exec(authStatusArgs(), { timeoutMs: 30_000 }));
  return {
    ok: status.ok,
    ...(status.org ? { org: status.org } : {}),
    message: redactWithEnv(status.message),
  };
}
