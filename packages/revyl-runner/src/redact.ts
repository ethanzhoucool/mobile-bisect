/**
 * Credential scrubbing for everything this package emits.
 *
 * Deliberately narrow so it never mangles the presigned S3 artifact URLs the
 * report needs intact (`X-Amz-Signature`, `X-Amz-Credential`, …), those are
 * short-lived, scoped read grants, not credentials worth hiding.
 */

export const REDACTED = '[redacted]';

/** Query params that are secrets. AWS SigV4 params are deliberately absent. */
const SECRET_QUERY_KEYS = 'api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|password|secret';

/**
 * AWS SigV4 query params (`X-Amz-Credential`, `X-Amz-Security-Token`, …) read as
 * credential-shaped but are scoped, expiring read grants the report renders.
 * Redacting them silently breaks every screenshot in the report.
 */
const SIGV4_PARAM = /^X-Amz-/i;

const PATTERNS: Array<[RegExp, (...m: string[]) => string]> = [
  // KEY=value / "key": "value" for credential-shaped names.
  [
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passphrase|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|credential)[A-Za-z0-9_.-]*"?\s*[:=]\s*"?)([^\s"',;}]{4,})/gi,
    (m: string, lead: string) => (SIGV4_PARAM.test(lead) ? m : `${lead}${REDACTED}`),
  ],
  // Authorization: Bearer|Token|Basic <credential>
  [
    /\b(authorization\s*[:=]\s*"?)((?:bearer|token|basic)\s+)?([A-Za-z0-9._\-+/=]{8,})/gi,
    (_m, lead: string, scheme: string | undefined) => `${lead}${scheme ?? ''}${REDACTED}`,
  ],
  // Secret-bearing query params only, AWS SigV4 params survive untouched.
  [
    new RegExp(`([?&](?:${SECRET_QUERY_KEYS})=)([^&\\s"'#]+)`, 'gi'),
    (_m, lead: string) => `${lead}${REDACTED}`,
  ],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
  // Vendor-prefixed keys, Revyl's `rk_`/`rvl_` included.
  [/\b(?:rk|rvl|revyl|sk|pk_live|ghp|gho|ghu|ghs|ghr|xox[abprs]|shpat)[_-][A-Za-z0-9_-]{12,}/gi, () => REDACTED],
  // Credentials embedded in a URL: https://user:token@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, (_m, scheme: string) => `${scheme}${REDACTED}@`],
];

/** Replace credential-shaped substrings with `[redacted]`. */
export function redactString(input: string): string {
  let out = input;
  for (const [re, replace] of PATTERNS) {
    out = out.replace(re, (...args) => replace(...(args as string[])));
  }
  return out;
}

/**
 * Also blanket-replace the live `REVYL_API_KEY` value wherever it appears, so a
 * key echoed in an unrecognised shape still never reaches a log or a report.
 */
export function redactWithEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = redactString(input);
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Deep-clone a JSON-ish value with every string passed through `redactString`. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out as unknown as T;
  }
  return value;
}

/** Redact an Error's message in place-ish, returning a new Error of the same name. */
export function redactError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const out = new Error(redactWithEnv(e.message));
  out.name = e.name;
  if (e.stack) out.stack = redactWithEnv(e.stack);
  return out;
}
