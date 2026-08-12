import { describe, expect, it } from 'vitest';
import { parseSessionReport } from './cli-adapter.js';
import { fixtureText, ok } from './fixtures.testutil.js';
import { REDACTED, redactError, redactString, redactValue, redactWithEnv } from './redact.js';

describe('redactString', () => {
  it.each([
    // Deliberately not shaped like any vendor's real key prefix: a fixture that
    // trips secret scanners blocks every push and teaches contributors to ignore
    // the warning.
    ['REVYL_API_KEY=notarealkey_abcdefghijklmnopqrst', 'notarealkey_abcdefghijklmnopqrst'],
    ['api_key: sk-proj-0123456789abcdefghij', 'sk-proj-0123456789abcdefghij'],
    ['{"access_token": "0123456789abcdefghij"}', '0123456789abcdefghij'],
    ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['authorization=Token 0123456789abcdef', '0123456789abcdef'],
    ['https://api.example.com/v1?api_key=supersecretvalue', 'supersecretvalue'],
    ['https://api.example.com/v1?access_token=supersecretvalue&x=1', 'supersecretvalue'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGciOiJIUzI1NiJ9'],
    ['git remote: https://user:ghp_0123456789abcdefghij@github.com/o/r', 'ghp_0123456789abcdefghij'],
    ['revyl auth login --api-key=rvl_0123456789abcdefgh', 'rvl_0123456789abcdefgh'],
  ])('scrubs %s', (input, secret) => {
    const out = redactString(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('leaves presigned S3 artifact URLs intact, the report needs them', () => {
    const url =
      'https://test-metadata-revyl.s3.amazonaws.com/sess/actions/a/action-0-before.png' +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request' +
      '&X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=' +
      '0'.repeat(64);
    expect(redactString(url)).toBe(url);
  });

  it('leaves every presigned URL in a real recorded report intact', () => {
    const before = parseSessionReport(ok('device-report'))!.screenshotUrls;
    const after = parseSessionReport({ ...ok('device-report'), stdout: redactString(fixtureText('device-report')) })!
      .screenshotUrls;
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('leaves ordinary prose and CLI output alone', () => {
    const line = '$ revyl device validation "the order confirmation screen appears" --json';
    expect(redactString(line)).toBe(line);
    expect(redactString('Error: validation failed')).toBe('Error: validation failed');
  });

  it('is idempotent', () => {
    const once = redactString('api_key=0123456789abcdefghij');
    expect(redactString(once)).toBe(once);
  });
});

describe('redactWithEnv', () => {
  it('blanket-replaces a live key value even in an unrecognised shape', () => {
    const env = { REVYL_API_KEY: 'zzzz-not-key-shaped-9999' } as NodeJS.ProcessEnv;
    const out = redactWithEnv('worker rejected credential zzzz-not-key-shaped-9999 (401)', env);
    expect(out).not.toContain('zzzz-not-key-shaped-9999');
    expect(out).toContain(REDACTED);
  });

  it('ignores short and non-credential env values so output is not shredded', () => {
    const env = { REVYL_API_KEY: 'abc', HOME: '/Users/dev' } as NodeJS.ProcessEnv;
    expect(redactWithEnv('abc lives in /Users/dev', env)).toBe('abc lives in /Users/dev');
  });
});

describe('redactValue', () => {
  it('walks nested objects and arrays', () => {
    const out = redactValue({
      steps: [{ cmd: 'curl -H "Authorization: Bearer abcdefghijklmnop"' }],
      nested: { env: { note: 'api_key=0123456789abcdefghij' } },
      count: 3,
      flag: true,
      nothing: null,
    });
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(out)).not.toContain('0123456789abcdefghij');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
  });
});

describe('redactError', () => {
  it('scrubs the message and the stack but keeps the error name', () => {
    const err = new TypeError('failed with api_key=0123456789abcdefghij');
    const out = redactError(err);
    expect(out.name).toBe('TypeError');
    expect(out.message).not.toContain('0123456789abcdefghij');
    expect(out.stack ?? '').not.toContain('0123456789abcdefghij');
  });

  it('accepts non-Error throwables', () => {
    expect(redactError('api_key=0123456789abcdefghij').message).toContain(REDACTED);
  });
});
