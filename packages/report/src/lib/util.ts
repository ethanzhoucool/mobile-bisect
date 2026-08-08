export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 0..1 -> 0..1, standard smooth ease-out for scripted reveal beats. */
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/** Progress of `t` through the window [a, b], clamped. */
export const spanned = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Deterministic: formats the ISO string directly, never via local time. */
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}  ${m[4]}:${m[5]}`;
}
