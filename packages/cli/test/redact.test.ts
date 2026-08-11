import { describe, expect, it } from 'vitest';
import { containsSecret, redact, redactDeep } from '../src/redact.js';

describe('redact', () => {
  it('scrubs the literal value of a credential-shaped env var', () => {
    const secret = 'rvl_live_9f3ac21bd44e5f6789abcdef01234567';
    process.env.REVYL_API_KEY = secret;
    try {
      const scrubbed = redact(`device start failed, sent ${secret} to the gateway`);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain('[redacted]');
    } finally {
      delete process.env.REVYL_API_KEY;
    }
  });

  it('scrubs key-shaped material it has never seen before', () => {
    const cases = [
      'Authorization: Bearer abcdef1234567890abcdef',
      'REVYL_API_KEY=sk-live-abcdefghijklmnop1234',
      'GET https://api.revyl.ai/run?api_key=abcdef123456789',
      'https://user:hunter2hunter2@git.example.com/app.git',
    ];
    for (const text of cases) {
      expect(containsSecret(text)).toBe(true);
      expect(redact(text)).toContain('[redacted]');
    }
  });

  it('leaves the things a report needs intact', () => {
    const sha = '8d4c2f19b3e7a5c0d8f2b6a4e9c1d7f3a5b8e204';
    expect(redact(`culprit ${sha}, Refactor order response handling`)).toContain(sha);
    expect(redact('POST /orders returned 200 but the app stayed on checkout.')).toBe(
      'POST /orders returned 200 but the app stayed on checkout.',
    );
  });

  it('walks nested structures without changing their shape', () => {
    process.env.REVYL_API_KEY = 'rvl_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    try {
      const event = {
        type: 'commit.completed',
        result: {
          sha: 'abc123',
          reason: 'auth failed with rvl_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          screenshots: ['https://artifacts.revyl.ai/a.png'],
          attempt: 1,
          passed: false,
        },
      };
      const clean = redactDeep(event);

      expect(clean.result.reason).not.toContain('rvl_live_');
      expect(clean.result.sha).toBe('abc123');
      expect(clean.result.screenshots).toEqual(['https://artifacts.revyl.ai/a.png']);
      expect(clean.result.attempt).toBe(1);
      expect(clean.result.passed).toBe(false);
      expect(Object.keys(clean.result)).toEqual(Object.keys(event.result));
    } finally {
      delete process.env.REVYL_API_KEY;
    }
  });
});
