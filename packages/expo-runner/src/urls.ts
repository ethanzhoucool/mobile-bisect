/**
 * URL construction for the dev-client handoff.
 *
 * A cloud device running an Expo dev-client build does not consume a raw Metro
 * URL, it consumes a deep link into the dev-client's own launcher, which then
 * points its JS runtime at the given packager.
 */

export interface ExpoAppConfigLike {
  expo?: {
    scheme?: string | string[];
    slug?: string;
    name?: string;
    [key: string]: unknown;
  };
  scheme?: string | string[];
  slug?: string;
  [key: string]: unknown;
}

/** `expo.scheme` (first entry when it's an array), falling back to `expo.slug`. */
export function resolveScheme(appConfig: unknown): string | undefined {
  if (!appConfig || typeof appConfig !== 'object') return undefined;
  const root = appConfig as ExpoAppConfigLike;
  const expo = (root.expo ?? root) as ExpoAppConfigLike['expo'];
  if (!expo || typeof expo !== 'object') return undefined;

  const raw = expo.scheme;
  const scheme = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.length > 0) : raw;
  if (typeof scheme === 'string' && scheme.length > 0) return scheme;

  const slug = expo.slug;
  if (typeof slug === 'string' && slug.length > 0) return slug;
  return undefined;
}

export function metroUrl(host: string, port: number): string {
  return `http://${formatHost(host)}:${port}`;
}

/**
 * `exp+<scheme>://expo-development-client/?url=<urlencoded packager url>`.
 * The `exp+` prefix is what the dev client registers in addition to the bare
 * app scheme, so this works even when the app itself handles `<scheme>://`.
 */
export function devClientDeepLink(scheme: string, packagerUrl: string): string {
  const clean = scheme.replace(/^exp\+/, '');
  if (!clean) throw new Error('cannot build a dev-client deep link without an app scheme');
  return `exp+${clean}://expo-development-client/?url=${encodeURIComponent(packagerUrl)}`;
}

export interface BundleUrls {
  /** Dev-client deep link, or undefined when the app config declares no scheme. */
  bundleUrl?: string;
  /** Raw packager URL, always present. */
  metroUrl: string;
  scheme?: string;
}

export function buildBundleUrls(opts: { appConfig: unknown; host: string; port: number }): BundleUrls {
  const url = metroUrl(opts.host, opts.port);
  const scheme = resolveScheme(opts.appConfig);
  const out: BundleUrls = { metroUrl: url };
  if (scheme) {
    out.scheme = scheme;
    out.bundleUrl = devClientDeepLink(scheme, url);
  }
  return out;
}

/** Bare IPv6 literals need brackets before they can go in a URL. */
function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}
