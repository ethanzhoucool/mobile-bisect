/**
 * Credential scrubbing for anything we persist or print.
 *
 * Deliberately narrow: it targets shapes that are unambiguously secrets so it
 * never mangles signed artifact URLs (X-Amz-Signature & friends), which the
 * report needs intact.
 */

const PLACEHOLDER = '[redacted]';

const PATTERNS: RegExp[] = [
  // KEY=value / "KEY": "value" for anything named like a credential
  /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SESSION[_-]?TOKEN))\b(\s*[:=]\s*"?)([^\s"',;}&#]+)/gi,
  // Authorization: Bearer / Basic / Token <credential>
  /\b(authorization\s*[:=]\s*"?)((?:bearer|basic|token)\s+)?([A-Za-z0-9._\-+/=]{8,})/gi,
  // query params: ?api_key=… &access_token=… &auth=…
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|auth|token|key|password)=)([^&\s"'#]+)/gi,
  // Well-known provider prefixes
  /\b(sk|rk|pk_live|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_\-]{16,}\b/g,
  // Credentials embedded in a url
  /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
];

const SECRET_ENV = /(API[_-]?KEY|SECRET|PASSWORD|PASSPHRASE|TOKEN|CREDENTIAL)/i;

/**
 * Literal values of credential-shaped env vars, longest first so a key that
 * contains another as a prefix still redacts fully. Short values are ignored -
 * scrubbing a 6-char string would corrupt unrelated output.
 */
function envSecretValues(): string[] {
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 12 && SECRET_ENV.test(k)) seen.add(v);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace credential-shaped substrings with `[redacted]`. */
export function redactString(input: string): string {
  let out = input;
  // Exact env values first: catches a bare key that matches no pattern below.
  for (const secret of envSecretValues()) {
    out = out.replace(new RegExp(escapeRe(secret), 'g'), PLACEHOLDER);
  }
  out = out.replace(PATTERNS[0]!, (_m, k: string, sep: string) => `${k}${sep}${PLACEHOLDER}`);
  out = out.replace(PATTERNS[1]!, (_m, k: string, scheme: string | undefined) =>
    `${k}${scheme ?? ''}${PLACEHOLDER}`,
  );
  out = out.replace(PATTERNS[2]!, (_m, k: string) => `${k}${PLACEHOLDER}`);
  out = out.replace(PATTERNS[3]!, PLACEHOLDER);
  out = out.replace(PATTERNS[4]!, (_m, scheme: string, user: string) => `${scheme}${user}:${PLACEHOLDER}@`);
  return out;
}

/** Deep-clone a JSON-ish value with every string passed through `redactString`. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
