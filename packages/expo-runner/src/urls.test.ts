import { describe, expect, it } from 'vitest';

import { buildBundleUrls, devClientDeepLink, metroUrl, resolveScheme } from './urls.js';

describe('resolveScheme', () => {
  it('prefers expo.scheme', () => {
    expect(resolveScheme({ expo: { scheme: 'cartly', slug: 'cartly-app' } })).toBe('cartly');
  });

  it('takes the first entry of an array scheme', () => {
    expect(resolveScheme({ expo: { scheme: ['cartly', 'cartly-dev'] } })).toBe('cartly');
  });

  it('falls back to expo.slug', () => {
    expect(resolveScheme({ expo: { slug: 'cartly-app' } })).toBe('cartly-app');
  });

  it('accepts an unwrapped config object', () => {
    expect(resolveScheme({ scheme: 'aura' })).toBe('aura');
  });

  it.each([undefined, null, {}, { expo: {} }, { expo: { scheme: '' } }, 'nope'])(
    'returns undefined for %s',
    (config) => expect(resolveScheme(config)).toBeUndefined(),
  );
});

describe('devClientDeepLink', () => {
  it('percent-encodes the packager URL', () => {
    expect(devClientDeepLink('cartly', 'http://127.0.0.1:8081')).toBe(
      'exp+cartly://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    );
  });

  it('does not double-prefix a scheme that already carries exp+', () => {
    expect(devClientDeepLink('exp+cartly', 'http://10.0.0.4:8082')).toBe(
      'exp+cartly://expo-development-client/?url=http%3A%2F%2F10.0.0.4%3A8082',
    );
  });

  it('encodes a relay hostname with a path', () => {
    expect(devClientDeepLink('demo', 'https://relay.example.com/tunnel/abc')).toBe(
      'exp+demo://expo-development-client/?url=https%3A%2F%2Frelay.example.com%2Ftunnel%2Fabc',
    );
  });

  it('refuses an empty scheme', () => {
    expect(() => devClientDeepLink('', 'http://127.0.0.1:8081')).toThrow(/app scheme/);
  });
});

describe('metroUrl', () => {
  it('formats host and port', () => {
    expect(metroUrl('127.0.0.1', 8081)).toBe('http://127.0.0.1:8081');
  });

  it('brackets an IPv6 literal', () => {
    expect(metroUrl('::1', 8081)).toBe('http://[::1]:8081');
  });
});

describe('buildBundleUrls', () => {
  it('returns the deep link plus the raw packager URL', () => {
    const urls = buildBundleUrls({
      appConfig: { expo: { scheme: 'cartly', slug: 'cartly-app' } },
      host: 'relay.internal',
      port: 8092,
    });
    expect(urls).toEqual({
      scheme: 'cartly',
      metroUrl: 'http://relay.internal:8092',
      bundleUrl: 'exp+cartly://expo-development-client/?url=http%3A%2F%2Frelay.internal%3A8092',
    });
  });

  it('omits the deep link when no scheme can be derived', () => {
    const urls = buildBundleUrls({ appConfig: {}, host: '127.0.0.1', port: 8081 });
    expect(urls.bundleUrl).toBeUndefined();
    expect(urls.metroUrl).toBe('http://127.0.0.1:8081');
  });
});
