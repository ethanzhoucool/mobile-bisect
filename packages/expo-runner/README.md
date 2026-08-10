# @mobile-bisect/expo-runner

Prepares a candidate commit's JavaScript for a cloud device — without rebuilding the native binary.

## The core insight

A normal "bisect a mobile regression" loop is unusable: every candidate commit means an `eas build`,
so six rounds is a two-hour wait. `expo-runner` skips that entirely.

An Expo **dev client** is a native binary whose only job is to load JavaScript from somewhere else.
Build it **once**, install it on a cloud device once, and every candidate commit becomes a URL:

```
git worktree (sha)  ->  install deps  ->  serve that commit's JS  ->  exp+<scheme>://…?url=…
                                                                       |
                                                     revyl-runner opens it on the cloud device
```

A bisect round drops from ~20 minutes to seconds. The price of the trick is that it only works for
**JavaScript-only** changes — see [the native-change guard](#the-native-change-guard). For a range
that does touch native code, `@mobile-bisect/native-runner` compiles each candidate for real:
slower, but correct.

`ExpoAdapter` is the `FrameworkAdapter` face over everything below; `ExpoCandidateRunner` is the
same machinery if you want to drive it yourself.

## Usage

```ts
import { ExpoCandidateRunner, detectNativeChangeFromGit, NativeChangeError } from '@mobile-bisect/expo-runner';

// Refuse the run up front if the range is not JS-only.
const report = await detectNativeChangeFromGit(repo, goodSha, badSha);
if (report.native) throw new NativeChangeError(report, goodSha, badSha);

const runner = new ExpoCandidateRunner({
  projectRoot: repo,
  mode: 'metro',          // default
  host: relayHostname,    // see "Reachability"
});

const prep = await runner.prepare(worktreePath, sha);
// prep.bundleUrl  -> exp+cartly://expo-development-client/?url=http%3A%2F%2F…%3A8081
// prep.metroUrl   -> http://…:8081
// prep.metroPort  -> 8081
await prep.dispose();     // or runner.dispose() to tear down everything
```

### API

| Export | What it does |
| --- | --- |
| `ExpoCandidateRunner` | `prepare(worktreePath, sha)` -> `CandidatePrep`; `dispose()` tears down every outstanding prep |
| `detectExpoProject(dir)` | `{ ok, sdkVersion?, usesRouter?, reason? }` — never throws |
| `installDeps(worktree, cacheDir)` | Lockfile-pinned install with a shared, content-hashed `node_modules` cache |
| `detectNativeChange(input)` | Pure detector: changed files + both `package.json`s -> `NativeChangeReport` |
| `detectNativeChangeFromGit(repo, good, bad)` | `git diff --name-only` shim over the pure detector |
| `NativeChangeError` | Typed guard error: `changedPaths`, `changedNativeModules`, `goodRef`, `badRef` |
| `PortAllocator` | Bind-proven, collision-free port handout |
| `detectPackageManager` / `installCommandFor` / `lockfileCacheKey` | The install pieces, exported for reuse and tests |
| `buildBundleUrls` / `devClientDeepLink` / `resolveScheme` | The dev-client URL builder |
| `spawnGroup` / `ProcessGroupRegistry` | Detached process groups with guaranteed teardown |

## The two modes

### `mode: 'metro'` (default)

Runs `npx expo start --port <port> --dev-client --non-interactive` inside the worktree and waits for
Metro to answer `packager-status:running` on `http://127.0.0.1:<port>/status`.

- **Use it for**: almost everything. Startup is a few seconds, and the device re-fetches the bundle
  on launch, so each candidate is cheap.
- `bundleUrl` is the dev-client deep link `exp+<scheme>://expo-development-client/?url=<encoded packager url>`,
  where `<scheme>` comes from `expo.scheme` in `app.json` and falls back to `expo.slug`.
  The raw packager URL is also returned as `metroUrl`.
- `CI` is explicitly **stripped** from the child environment. Setting `CI=1` makes `@expo/cli` disable
  Fast Refresh — the exact mechanism the swap depends on. `EXPO_NO_TELEMETRY=1` and `EXPO_OFFLINE=1`
  are set to cut cold-start time.
- Readiness is polled over HTTP, never scraped from stdout — the CLI's banner text changes between
  releases. stdout/stderr are still captured, and the last lines are attached to a timeout error.

### `mode: 'export'`

Runs `npx expo export --platform ios --output-dir <cacheDir>/exports/<sha>` and serves the output over
a small `node:http` static server. `bundleUrl` is the served directory root.

- **Use it for**: determinism and post-mortems. The export is a frozen artifact — no watcher, no Fast
  Refresh, no chance that a stale in-memory Metro graph explains a flaky verdict. Also the fallback
  when a long-lived Metro is impractical (locked-down CI, a relay that only forwards plain HTTP).
- Slower per candidate: a full bundle instead of an incremental one.

## The native-change guard

Swapping JS under a fixed binary is only honest when the binary would not have changed. Before a run,
feed the diff to `detectNativeChange`; if `native` is true, fail with `NativeChangeError` rather than
producing a confident, wrong culprit.

| Signal | Native? | Why |
| --- | --- | --- |
| `ios/**`, `android/**` (repo root or any workspace, e.g. `apps/mobile/ios/…`) | yes | native sources compile into the binary |
| `Podfile`, `Podfile.lock`, `*.podspec` | yes | CocoaPods graph changed |
| `build.gradle`, `settings.gradle`, `gradle.properties`, `AndroidManifest.xml` | yes | Gradle build / manifest changed |
| `*.xcodeproj`, `*.xcworkspace`, `Info.plist`, `*.entitlements` | yes | Xcode project or app capabilities changed |
| `app.json`, `app.config.js/ts/mjs/cjs` | yes | config plugins run at prebuild; a plugin change needs a rebuild |
| Dependency matching `expo-*`, `react-native-*`, `@expo/*`, `@react-native-*/*` added, removed, or **version-bumped at all** | yes | a patch bump of a native module still ships new native code |
| `expo-router` **major** bump | yes | its native peers move with the major |
| `expo-router` patch/minor bump | no | JS-only in recent SDKs |
| `devDependencies`-only change | no | never reaches the binary |
| `zod`, `date-fns`, `lodash`, and other pure-JS deps | no | JS-only |
| `src/ios-tips.ts`, `components/AndroidBanner.tsx` | no | path rules match directory segments, not substrings |

The detector is pure and takes `{ changedFiles, goodPackageJson, badPackageJson }`, so the rules are
unit-tested without a repo. `detectNativeChangeFromGit` is the thin `execFile('git', …)` shim.

The bias is toward **false positives**: refusing a bisect is cheap, blaming the wrong commit is not.

## Dependency cache

Six candidates must not mean six cold `npm ci` runs.

1. The package manager comes from the lockfile in the worktree:

   | Lockfile | Manager | Install argv |
   | --- | --- | --- |
   | `package-lock.json` | npm | `npm ci --cache <cacheDir>/npm` |
   | `yarn.lock` | yarn | `yarn install --frozen-lockfile` (`YARN_CACHE_FOLDER=<cacheDir>/yarn`) |
   | `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile --store-dir <cacheDir>/pnpm` |
   | `bun.lockb` / `bun.lock` | bun | `bun install --frozen-lockfile` (`BUN_INSTALL_CACHE_DIR=<cacheDir>/bun`) |

   Every install is strictly lockfile-pinned. **No lockfile is a hard error** — a bisect over floating
   dependency ranges attributes the regression to whichever commit you happened to install on.

2. A warm `node_modules` is kept per content hash under `<cacheDir>/nm/<hash>`, where the hash is
   `sha256(package manager + node major + lockfile bytes)`. The node major is in the key because native
   addons are ABI-bound to it.

3. On a hit, the tree is restored with a clone, not a re-install: APFS `cp -Rc` (copy-on-write) on
   macOS, `cp -al` (hardlink) elsewhere, plain `cp -R` as the fallback. The destination is verified
   afterward, and a short clone is thrown away rather than handed back.

4. After a cold install the tree is seeded into the cache atomically — written to `<hash>.tmp-<pid>-<rand>`
   and renamed — so a concurrent candidate can never read a half-copied entry. If another candidate won
   the race, the loser discards its copy. A failed seed never fails the candidate.

All argv is passed as arrays through `execFile`; nothing is interpolated into a shell string.

## Port allocation

`basePort + index` breaks under `--concurrency 4`: candidates are prepared and disposed out of order,
and the machine may already be running a Metro of its own. `PortAllocator` instead:

- scans a configurable range (default **8081-8181**),
- **binds a real `node:net` server** to prove each port is free, then releases it,
- adds the port to an in-process reserved set **before** probing, closing the race window between
  "probe succeeded" and "Metro actually bound it",
- releases the port on `dispose()` — including when `prepare()` fails partway,
- throws `PortRangeExhaustedError` naming the range when nothing is left.

## Process-cleanup contract

`npx expo start` is a chain — npx, `@expo/cli`, Metro workers. `child.kill()` reaps the head and leaves
Metro holding the port, which poisons every later candidate. So:

- children are spawned `detached: true` (their own process group) and killed with `process.kill(-pid)`;
- `dispose()` sends `SIGTERM`, waits ~5s, escalates to `SIGKILL`, and resolves **only after the process
  has actually exited** — awaited on `exit`, not `close`, because a grandchild can hold the inherited
  stdio pipes open past its parent's death;
- `ExpoCandidateRunner.dispose()` disposes every outstanding prep, and each prep's `dispose()` is idempotent;
- `prepare()` tears down its own half-started child if readiness times out or throws, and returns the port;
- `SIGINT` / `SIGTERM` / `beforeExit` handlers are installed **once per runner instance**, kill all live
  groups synchronously, **remove themselves**, and then **re-raise** the signal so the process still exits
  with the standard disposition (130 for Ctrl-C). No swallowed signals, no leaked listeners across runs.

Verified empirically, not assumed: `src/process.test.ts` and `src/runner.test.ts` spawn a child that
itself spawns a grandchild, dispose through the real code path, and assert via `ps` that neither pid
survives.

## Reachability

`host` defaults to `127.0.0.1`, which a **cloud device cannot reach** — loopback is this machine only.
Readiness is always probed on loopback, but the host baked into `bundleUrl` is whatever you pass:

```ts
new ExpoCandidateRunner({ projectRoot, host: 'my-tunnel-123.relay.example' });
```

`@mobile-bisect/revyl-runner` supplies that relay/tunnel hostname and points the cloud device at the
resulting deep link. Without it, the URL resolves to the device's own loopback and the dev client
simply fails to connect.

## Testing

```
npx vitest run packages/expo-runner
```

The pure logic — native-change rules, port allocation, package-manager detection and argv, cache keys,
project detection, URL building — is tested without an Expo app or a network. The runner tests drive
the real `prepare()`/`dispose()` path against a fake Metro that answers `/status`.
