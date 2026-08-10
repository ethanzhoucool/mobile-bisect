# Framework adapters

The bisection engine asks one question per candidate: *make this commit runnable
on a device.* An adapter answers it. Everything framework-specific — Metro,
`xcodebuild`, `gradlew`, CocoaPods, signing — lives behind that question, and
`core` knows about none of it.

## The two kinds of answer

| Kind | What the adapter returns | Cost per candidate |
|---|---|---|
| `bundle` | A URL for the device to open | seconds |
| `binary` | A local `.app.zip` / `.apk` to install | minutes |

That difference is the whole story of this design. A bundle candidate reuses one
native binary that was built once; a binary candidate is a real compile. Both are
correct, but only one of them is fast, so the tool picks the fast one whenever it
legitimately can — and refuses to when it cannot.

## Shipped adapters

| Name | Languages | Prepares by | Platforms | Toolchain needed |
|---|---|---|---|---|
| `expo` | JS/TS on Expo | starting Metro or exporting a bundle, then deep-linking the dev client | ios, android | node |
| `xcode` | Swift, Objective-C | `xcodebuild -sdk iphonesimulator` → zip the `.app` | ios | Xcode, here |
| `gradle` | Kotlin, Java | `./gradlew :app:assembleDebug` → the `.apk` | android | JDK + Android SDK, here |
| `revyl-remote` | anything the project can build | `revyl build --remote` on Revyl's runners | whatever the config declares | **none** |

Pick one with `--framework`, or let detection choose:

```bash
mobile-bisect run --good v1.4.0 --bad HEAD --framework xcode  --scheme Orbit
mobile-bisect run --good v1.4.0 --bad HEAD --framework gradle --platform android
```

`--framework` accepts the words people actually type: `ios` and `swift` mean
`xcode`, `android` and `kotlin` mean `gradle`, `remote` and `cloud` mean
`revyl-remote`.

### Building nothing locally

`revyl-remote` is the adapter for a machine with no mobile toolchain on it —
and, increasingly, for one that has a toolchain and would rather not spend an
hour of it on a search:

```bash
mobile-bisect run --good v2.0.0 --bad HEAD --framework revyl-remote
```

Per candidate it points `revyl build --remote` at that commit's worktree. The
CLI uploads the tree, a Revyl macOS runner executes the project's own build
command from `.revyl/config.yaml`, and what comes back is a build id already
registered with the runtime — so unlike the local adapters there is no artifact
to upload afterwards.

Two things follow from delegating to the project's own config:

- **It is framework-agnostic.** The config says how the project builds itself,
  so Swift, Kotlin, Flutter and bare React Native all work through one adapter.
- **The build command must be committed.** It runs at the candidate commit. A
  script that only exists in your working tree is missing exactly when the
  bisect needs it. `.revyl/config.yaml` itself is usually untracked, so the
  adapter copies it in from your checkout and removes it again afterwards —
  a seeded file left behind would make the worktree diff lie.

Measured on a SwiftUI app (Vault, ~3.9k lines): **51 seconds per candidate
build**, so a 64-commit range is about six minutes of build time.

## Detection

Every adapter is asked, and the most confident one that says yes wins.

| Situation | Score |
|---|---|
| Expo project (an `expo` dependency) | 0.95 |
| `.xcworkspace` / `.xcodeproj` or `settings.gradle` at the repo root | 0.80 |
| the same, under `ios/` or `android/` | 0.55 |
| a `.revyl/config.yaml` with a build command (`revyl-remote`) | 0.35 |

`revyl-remote` scores below everything on purpose. Building in the cloud is the
right answer when there is no toolchain here, not the default when there is — a
local build has no upload and no queue. Ask for it explicitly, or set
`framework: 'revyl-remote'` in the config.

The ordering is deliberate. A prebuilt Expo app has `ios/` and `android/`
directories too, and swapping its JavaScript beats rebuilding either of them —
so Expo outranks both native adapters on a project that is genuinely both. A
bare React Native app has no `expo` dependency, so it falls through to `xcode`
or `gradle`, which is exactly right: those are the tools that can actually
rebuild it.

An adapter that finds a project but cannot commit to one interpretation says so
instead of guessing:

```
✖  framework   Xcode (Swift / Objective-C) — not ready
   ↳ Orbit.xcodeproj has 2 shared schemes (Orbit, OrbitStaging). Set `build.scheme` to pick one.
```

## Configuration

```ts
export default defineConfig({
  framework: 'xcode',        // or 'expo' | 'gradle' | 'auto'
  platform: 'ios',
  build: {
    projectDir: 'ios',       // where the native project lives, if not the root

    // xcode
    scheme: 'Orbit',
    configuration: 'Debug',  // Release strips the symbols the diagnosis reads
    workspace: 'Orbit.xcworkspace',

    // gradle
    module: 'app',
    variant: 'debug',
    task: ':app:assembleFreeDebug',   // overrides module + variant

    timeout: 1800,           // seconds per candidate build
  },
});
```

`--scheme`, `--variant` and `--project-dir` override the config for one run.

## What makes a native bisect bearable

A naive implementation would compile 64 commits. Three things stop that:

1. **Binary search.** 64 commits is 6 builds. This is the point of the tool.
2. **Caching by SHA.** A commit's source is fully determined by its SHA, so a
   finished artifact is keyed by `sha` plus the build parameters. Retries after
   an inconclusive verdict, resumes after Ctrl-C, and the final last-good /
   first-bad comparison all hit the cache instead of the compiler.
3. **Serialisation.** Two `xcodebuild`s at once are slower than one after the
   other — they contend for the same cores — and they corrupt a shared
   derived-data directory. Speculative candidates queue rather than race.

Artifacts live in `.mobile-bisect/build/artifacts/<platform>/<params>/<sha>/`
and the 24 most recent per configuration are kept.

## The Expo precheck

The Expo adapter is the one that can be wrong for a reason no verdict would
reveal. If the range touches `ios/`, `android/`, a Podfile, or the native module
set, a JavaScript swap tests the *old* binary with the *new* JavaScript — and
the answer comes back confident and wrong.

So it refuses, once, before any device starts, and names the adapters that can
do the job properly:

```
v1.4.0..HEAD contains a native change, which the Expo adapter cannot
honestly bisect.

  - native project directory: ios/Podfile
  - native module version changed: expo-camera 16.0.0 -> 16.0.7

  mobile-bisect run --framework xcode  --good <ref> --bad <ref>   # iOS
  mobile-bisect run --framework gradle --good <ref> --bad <ref>   # Android

That is minutes per candidate instead of seconds, but it is correct.
```

## Writing an adapter

Implement `FrameworkAdapter` from `@mobile-bisect/core`:

```ts
interface FrameworkAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly candidateKind: 'bundle' | 'binary';

  detect(projectPath: string): Promise<AdapterDetection>;
  precheck?(input: PrecheckInput): Promise<PrecheckResult>;
  prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate>;
  noteUploaded?(sha: string, buildId: string, platform: Platform): Promise<void>;
  dispose?(): Promise<void>;
}
```

Four rules the shipped adapters follow:

- **`detect` must not run the build tool.** `xcodebuild -list` and
  `gradlew projects` are authoritative and cost 10–30 seconds on a cold project.
  Detection runs on every `init` and every run, so it reads the filesystem
  instead and lets config settle anything genuinely ambiguous.
- **`prepare` throws `CandidatePrepareError` for a commit it cannot build.** That
  becomes `skipped`, never `bad`. A commit that does not compile is not evidence
  about the regression, and treating it as evidence produces a confident wrong
  answer.
- **`precheck` is where you refuse.** If the whole range is unanswerable, say so
  before a device starts rather than per candidate.
- **`dispose` is called exactly once per candidate**, and the adapter's own
  `dispose` once per run. Cached artifacts should survive both — a resumed run
  wants them, and so does the final comparison view.

Then register it: add the name to `FRAMEWORK_NAMES` in
`packages/cli/src/frameworks.ts` along with its package and export name. It is
loaded lazily, so a repo that never uses it never pays for it.

## Known gaps

- **The Expo adapter cannot reach a cloud device yet.** It starts Metro on this
  machine and hands the device a URL built from `host`, which defaults to
  `127.0.0.1` — and a cloud device cannot route to your loopback. The seam for a
  relay hostname exists (`ExpoCandidateRunnerOptions.host`) but nothing fills
  it; `revyl dev` owns the tunnel today, and it is a long-lived process bound to
  one worktree, which is the opposite of what a bisect wants. Until that is
  wired, Expo works under `--dry-run`, and real cloud runs should use
  `revyl-remote`.
- **Flutter** has no adapter. A Flutter app *is* detected by `xcode` and
  `gradle` (its `ios/Runner.xcworkspace` and `android/` are real), and building
  through them works once `flutter pub get` has generated the config — but
  nothing here runs the Flutter tooling for you. A proper `flutter` adapter
  would build with `flutter build ios --simulator`.
- **iOS device builds** are out of scope: cloud iOS is simulator-only, so
  `xcode` always builds for `iphonesimulator` and never signs.
- **Xcode incremental builds** get less reuse than they could. Every candidate
  compiles in a fresh worktree path, and Xcode's incremental state is keyed on
  absolute paths. Derived data is still shared, so module caches survive, but a
  candidate is closer to a clean build than a rebuild.
