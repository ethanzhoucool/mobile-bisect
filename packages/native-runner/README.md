# @mobile-bisect/native-runner

Framework adapters for apps that have to be compiled: **Swift and Objective-C**
through Xcode, **Kotlin and Java** through Gradle.

## The trade

`@mobile-bisect/expo-runner` takes a shortcut, one native binary, many
JavaScript bundles, seconds per candidate. There is no equivalent shortcut here.
A Swift change *is* a native change, so every candidate is a real compile and a
round costs minutes rather than seconds.

Three things make that tolerable:

- **Binary search.** 64 commits is 6 builds, not 64. This was always the point.
- **Caching by SHA.** A commit's source is fully determined by its SHA, so a
  finished artifact is keyed by the SHA plus the build parameters. A retry after
  an inconclusive verdict, a resume after Ctrl-C, and the final last-good /
  first-bad comparison all hit the cache.
- **Serialisation.** Two `xcodebuild`s at once are slower than one after the
  other, they contend for the same cores, and they corrupt a shared
  derived-data directory. Speculative candidates queue.

## Usage

```ts
import { XcodeAdapter, GradleAdapter } from '@mobile-bisect/native-runner';

const adapter = new XcodeAdapter({
  projectRoot: repo,
  scheme: 'Orbit',            // required when the project shares more than one
  configuration: 'Debug',     // Release strips the symbols the diagnosis reads
});

const detection = await adapter.detect(repo);
// { ok: true, confidence: 0.8, platforms: ['ios'], summary: 'Orbit.xcworkspace, scheme Orbit' }

const candidate = await adapter.prepare(sha, worktreePath, { platform: 'ios' });
// { kind: 'binary', appPath: '.../Orbit.app.zip', bundleId: 'com.orbit.store', ... }
```

```ts
const adapter = new GradleAdapter({
  projectRoot: repo,
  module: 'app',              // default
  variant: 'debug',           // default; release variants need signing config
});
```

Both find a project at the repo root or under `ios/` / `android/`, and score the
nested case lower so a prebuilt Expo app keeps its fast path.

## What each one runs

**Xcode**

```
pod install                                       # only when a Podfile is present
xcodebuild build -workspace <ws> -scheme <s> -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath <shared> CODE_SIGNING_ALLOWED=NO
zip -r -q -y <cache>/<Name>.app.zip <Name>.app
plutil -extract CFBundleIdentifier raw -o - <Name>.app/Info.plist
```

`zip -r` is not interchangeable with `ditto -c -k`. A ditto archive uploads
fine and then fails to install, because it stores the bundle differently than
the installer expects.

Signing is disabled outright: a simulator build needs no identity, and asking
for one on a machine without the team's certificates fails for a reason that has
nothing to do with the bug being hunted.

**Gradle**

```
./gradlew :app:assembleDebug --console=plain --build-cache
```

`--build-cache` matters more here than the equivalent would for Xcode. Gradle's
cache lives in `~/.gradle` and is keyed by task inputs rather than by path, so it
survives the throwaway worktrees that defeat Xcode's incremental build, the
second candidate is usually much faster than the first even though it compiles
in a directory that has never existed before.

The APK is copied out of the worktree before the worktree is deleted.

## Where things land

```
.mobile-bisect/build/
  DerivedData/<scheme>-<configuration>/      shared across candidates
  artifacts/<platform>/<params>/<sha>/
    entry.json                               artifact path, bundle id, build id
    <Name>.app.zip | app-debug.apk
```

The 24 most recent builds per configuration are kept; older ones are pruned.

## Failure is `skipped`, never `bad`

A commit that does not compile is not evidence about the regression. Both
adapters throw `CandidatePrepareError` with the compiler output attached, and the
search skips that commit and tries its neighbour. Treating a build failure as a
failing assertion would produce a confident, wrong answer, the one outcome
worse than no answer.

## Testing

Nothing in this package's suite spawns a compiler. Both adapters take their
executor as an option, and the tests pass a recording stub that materialises the
artifacts a real build would have produced. `zip` and `plutil` are emulated
faithfully, since the adapters depend on their behaviour and not just on having
called them.
