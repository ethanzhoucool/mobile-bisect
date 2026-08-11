/**
 * @mobile-bisect/expo-runner
 *
 * Prepares a candidate commit's JavaScript for a cloud device that is already
 * running an Expo dev-client build, no native rebuild per commit.
 */

export { ExpoAdapter, type ExpoAdapterOptions } from './adapter.js';

export {
  ExpoCandidateRunner,
  DEFAULT_READY_TIMEOUT_MS,
  waitForMetro,
  waitForHttp,
  type CandidatePrep,
  type ExpoCandidateRunnerOptions,
  type PrepareMode,
} from './runner.js';

export {
  detectExpoProject,
  parseSdkVersion,
  findAppConfigFile,
  readAppJson,
  APP_CONFIG_FILES,
  type ExpoProjectInfo,
} from './detect.js';

export {
  installDeps,
  detectPackageManager,
  installCommandFor,
  lockfileCacheKey,
  cloneTree,
  defaultCacheDir,
  nodeMajor,
  LOCKFILES,
  MissingLockfileError,
  type PackageManager,
  type DetectedPackageManager,
  type InstallCommand,
  type InstallDepsOptions,
  type CacheKeyInput,
  type CloneStrategy,
} from './deps.js';

export {
  NativeChangeError,
  detectNativeChange,
  detectNativeChangeFromGit,
  formatNativeChangeMessage,
  isNativePath,
  classifyNativePath,
  isNativeModuleName,
  majorOf,
  CURATED_NATIVE_MODULES,
  MAJOR_ONLY_NATIVE_MODULES,
  type NativeChangeInput,
  type NativeChangeReport,
  type GitNativeChangeOptions,
} from './native-change.js';

export {
  PortAllocator,
  PortRangeExhaustedError,
  isPortFree,
  DEFAULT_PORT_MIN,
  DEFAULT_PORT_MAX,
  type PortAllocatorOptions,
} from './ports.js';

export {
  buildBundleUrls,
  devClientDeepLink,
  metroUrl,
  resolveScheme,
  type BundleUrls,
  type ExpoAppConfigLike,
} from './urls.js';

export {
  ManagedProcess,
  ProcessGroupRegistry,
  spawnGroup,
  killProcessGroup,
  type SpawnGroupOptions,
  type ExitInfo,
} from './process.js';

export { serveDirectory, type StaticServer } from './static-server.js';
