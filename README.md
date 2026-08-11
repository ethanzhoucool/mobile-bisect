# mobile-bisect

**Git bisect, but it can see your app.**

You know the build is broken. You don't know which commit broke it. `mobile-bisect` replays the failing flow on a cloud device across your commit range and tells you the exact commit that caused it.

Swift, Kotlin, React Native, Expo, the search is the same; only the way a commit becomes runnable differs.

```bash
npx mobile-bisect \
  --good v1.4.0 \
  --bad HEAD \
  --flow flows/checkout.yaml \
  --expect "the order confirmation screen appears"
```

```
FIRST BAD COMMIT

  8d29fbc  Refactor order response handling
  Dan Oketch · 64 commits searched · 6 runs · 4m 21s

  POST /orders returned 200 in both builds.
  Navigation stopped after the response parser returned undefined.

  report → .mobile-bisect/runs/20260810T210613-checkout-flow/report.html
```

That is the included demo, not a mock-up, `examples/orbit-store` really does have those 64 commits, and `8d29fbc` really is the one that breaks checkout.

---

## Why

Finding the commit that broke a mobile flow means checking out an old commit, rebundling, booting a simulator, tapping through the flow by hand, deciding whether the bug is there, and repeating. Six times, if you're disciplined about it. Usually more.

Git already has the binary search. What's missing is something that can look at a running app and decide *yes, it's broken here.* That's the part `mobile-bisect` adds.

## How it works

1. `git rev-list --ancestry-path` enumerates the commits between your good and bad refs.
2. For each candidate the tool picks, it checks that commit out into a **temporary worktree**, your working tree is never touched.
3. A **framework adapter** makes that commit runnable. Expo swaps the JavaScript bundle into one reusable dev client; Xcode and Gradle compile the commit for real; `revyl-remote` compiles it on a cloud runner instead of on your machine.
4. It replays your flow on a Revyl cloud device and evaluates your plain-language assertion.
5. Good, bad, or inconclusive, the search space halves, and it goes again.
6. When one commit remains, you get synchronized recordings of the last good and first bad builds, plus the network trace, logs, and diff.

64 commits resolve in 6 runs. Whether those 6 runs take four minutes or forty depends on whether your commits need compiling.

## Frameworks

| `--framework` | Languages | How a candidate is prepared | Builds where |
|---|---|---|---|
| `expo` | JS/TS on Expo | Metro or an exported bundle, deep-linked into one dev client | here (seconds) |
| `xcode` | Swift, Objective-C | `xcodebuild -sdk iphonesimulator`, zipped and uploaded | here (minutes) |
| `gradle` | Kotlin, Java | `./gradlew :app:assembleDebug` | here (minutes) |
| `revyl-remote` | anything with a Revyl build config | `revyl build --remote` on Revyl's macOS runners | **in the cloud** |

`revyl-remote` needs no mobile toolchain on your machine at all, no Xcode, no
JDK, no Android SDK. It uploads each candidate's worktree, runs the project's
own build command on a Revyl runner, and installs the result on a cloud device.
Measured at ~51s per candidate for a 3.9k-line SwiftUI app.

Detection picks one, so most projects never pass the flag:

```bash
mobile-bisect run --good v1.4.0 --bad HEAD                       # detected
mobile-bisect run --good v1.4.0 --bad HEAD --framework xcode --scheme Orbit
mobile-bisect run --good v1.4.0 --bad HEAD --framework gradle --platform android
mobile-bisect run --good v2.0.0 --bad HEAD --framework revyl-remote   # nothing built locally
```

Expo wins on a project that is both, a prebuilt Expo app has an `ios/` directory too, and swapping its JavaScript beats rebuilding it. A bare React Native app has no `expo` dependency, so it falls through to `xcode` or `gradle`, which are the tools that can actually rebuild it.

Native builds are cached by commit SHA, so a retry, a resume, and the final last-good/first-bad comparison never recompile. See [`docs/framework-adapters.md`](docs/framework-adapters.md).

## Install

```bash
npx mobile-bisect init      # checks git, detects your framework, verifies Revyl auth
npx mobile-bisect run --good <sha> --bad <sha> --flow <file>
```

`init` walks you through authentication and writes a `mobile-bisect.config.ts`. Try it against the included demo first:

```bash
cd examples/orbit-store
npx mobile-bisect run --good v1.4.0 --bad HEAD --flow ../flows/checkout.yaml \
  --expect "the order confirmation screen appears" --dry-run
```

`--dry-run` executes the full search offline with a simulated runtime, so you can see the whole thing work before connecting a device.

## What v1 covers

Supported:

- **Expo** apps, when the changes between good and bad are JavaScript only
- **Swift / Objective-C** apps through Xcode, compiled per candidate
- **Kotlin / Java** apps through Gradle, compiled per candidate
- **Any project with a Revyl build config**, compiled per candidate on Revyl's runners with no local toolchain
- iOS and Android cloud devices
- One deterministic flow, one assertion
- Commit ranges from 2 to 64 candidates
- Good / bad / skipped / inconclusive, with one automatic retry
- Resume after an interrupted run, reusing cached builds
- A live browser view and a self-contained HTML report

Not yet:

- The Expo adapter against a **cloud** device, it serves each candidate's bundle from localhost, which a cloud device cannot reach. `--dry-run` works; for a real cloud run use `--framework revyl-remote`.
- A Flutter adapter (`xcode` and `gradle` do detect a Flutter app's native projects, but nothing runs the Flutter tooling for you)
- Multiple flows in one bisection
- Automatic code repair

A range containing native changes is no longer a dead end, it is a reason to use `--framework xcode` or `--framework gradle` instead of the Expo fast path. The Expo adapter refuses such a range up front rather than swapping JavaScript underneath the wrong binary and answering confidently wrong.

## The demo app

`examples/orbit-store` is a small Expo commerce app with a real 64-commit history and one deliberately planted regression: a response-parsing refactor moves the order payload under a `data` envelope, but the navigation call still reads the old path. The order request succeeds with a 200 in both builds. Only one of them reaches the confirmation screen.

It's the honest version of the problem, the failure is invisible to your network layer and obvious on the screen.

The boundaries are real commits, not fixtures:

| | Commit | Subject |
|---|---|---|
| `v1.4.0` (good) | `59bafb4` | Release v1.4.0 |
| last good | `dc7eedf` | Preserve checkout navigation |
| **first bad** | `8d29fbc` | Refactor order response handling |
| `HEAD` (bad) | `fccf6af` | Update README screenshots |

`examples/orbit-store/scripts/verify-bisect.sh` proves it independently with a plain `git bisect run`, it lands on index 41 in 6 steps without involving this tool at all.

## Safety

- The tool never runs `git checkout`, `reset`, `stash`, or `bisect` in your working tree. Candidates are checked out into detached worktrees and cleaned up on success, failure, and Ctrl-C.
- It refuses to start on a dirty tree unless you pass `--allow-dirty`, and even then it leaves your changes alone.
- Authentication is read from your existing Revyl CLI session or `REVYL_API_KEY`. Keys are never accepted as flags and never written to logs, events, state, or reports.

## Runtime

The cloud device layer is provided by [Revyl](https://revyl.com), cloud devices, flow replay, video, screenshots, logs, and network traces. `mobile-bisect` talks to it through one small interface (`MobileRuntimeRunner`), so the search logic stays readable and swappable. See [`docs/revyl-adapter.md`](docs/revyl-adapter.md).

Authenticate once during `init`. A free account covers the demo.

## Docs

- [`docs/architecture.md`](docs/architecture.md), packages, bisection state machine, event stream
- [`docs/framework-adapters.md`](docs/framework-adapters.md), how a commit becomes runnable, and how to add a framework
- [`docs/visual-spec.md`](docs/visual-spec.md), the report UI specification
- [`docs/revyl-adapter.md`](docs/revyl-adapter.md), the cloud device integration

## License

MIT
