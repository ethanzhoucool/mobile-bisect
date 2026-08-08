import { describe, expect, it, afterEach } from 'vitest';
import { redactString, redactValue } from './redact.js';

const KEY = 'rv_live_9d2f7a6e3c5b8d1a4f9c2e7b';

afterEach(() => {
  delete process.env.REVYL_API_KEY;
});

describe('redactString', () => {
  it('scrubs a bare env-var value that matches no credential pattern', () => {
    process.env.REVYL_API_KEY = KEY;
    expect(redactString(`request failed with ${KEY} in headers`)).toBe(
      'request failed with [redacted] in headers',
    );
  });

  it('scrubs named assignments even when the env var is unset', () => {
    expect(redactString(`REVYL_API_KEY=${KEY}`)).toBe('REVYL_API_KEY=[redacted]');
  });

  it('scrubs bearer tokens and url-embedded credentials', () => {
    expect(redactString('Authorization: Bearer abcdef0123456789')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactString('https://user:hunter2pass@host/x')).toBe(
      'https://user:[redacted]@host/x',
    );
  });

  it('leaves signed artifact URLs intact — the report needs them', () => {
    const url =
      'https://artifacts.revyl.ai/demo/8d4c2f1/run.mp4?X-Amz-Signature=abc123def456&X-Amz-Expires=900';
    expect(redactString(url)).toBe(url);
  });

  it('leaves ordinary diagnostic prose untouched', () => {
    const s = 'POST /orders returned 200 in both builds.';
    expect(redactString(s)).toBe(s);
  });

  it('ignores short env values that would corrupt unrelated output', () => {
    process.env.REVYL_API_KEY = 'short';
    expect(redactString('a short word here')).toBe('a short word here');
  });
});

describe('redactValue', () => {
  it('scrubs nested strings without changing structure', () => {
    process.env.REVYL_API_KEY = KEY;
    expect(redactValue({ logs: [`token ${KEY}`], n: 7, ok: true })).toEqual({
      logs: ['token [redacted]'],
      n: 7,
      ok: true,
    });
  });
});
