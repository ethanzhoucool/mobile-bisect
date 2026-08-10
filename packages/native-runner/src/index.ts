/**
 * @mobile-bisect/native-runner
 *
 * Framework adapters for apps that have to be compiled per candidate: Swift and
 * Objective-C through Xcode, Kotlin and Java through Gradle. Both produce an
 * installable artifact rather than a URL, and both cache it by commit SHA.
 */

export { XcodeAdapter, type XcodeAdapterOptions } from './xcode.js';
export { GradleAdapter, type GradleAdapterOptions } from './gradle.js';

export {
  detectXcodeProject,
  detectGradleProject,
  parseIncludedModules,
  parseApplicationId,
  type XcodeProject,
  type GradleProject,
  type ProjectKind,
} from './detect.js';

export {
  findSimulatorApp,
  findApk,
  variantPath,
  zipApp,
  readBundleId,
  type FoundArtifact,
} from './artifact.js';

export { BuildCache, slug, type CacheKey, type CachedBuild } from './cache.js';

export {
  execBuild,
  BuildError,
  Mutex,
  type ExecFn,
  type ExecOptions,
  type ExecOutcome,
} from './exec.js';
