# mobile-bisect

**Git bisect, but it can see your app.**

You know the build is broken. You don't know which commit broke it. `mobile-bisect` replays the failing flow on a cloud device across your commit range and tells you the exact commit that caused it.

Swift, Kotlin, React Native, Expo, the search is the same; only the way a commit becomes runnable differs.

```bash
mobile-bisect run \
  --good v1.4.0 \
  --bad HEAD \
  --flow flows/checkout.yaml \
  --expect "the order confirmation screen appears"
```

```
FIRST BAD COMMIT

  8d4c2f1  Refactor order response handling
  dan.oketch · 64 commits searched · 6 runs · 1m 26s

  POST /orders returned 200 in both builds.
  Navigation stopped after the response parser returned undefined.

  report → .mobile-bisect/runs/orbit-checkout-demo/report.html
```

That transcript comes from `fixtures/demo-runs/orbit-checkout.jsonl`, a scripted
64-commit run used to develop the interface. `mobile-bisect replay` plays it back
through the real terminal UI and the real report, so you can see the shape of an
answer before you own a cloud device. It is a script, not a recording: the shas
and the authors in it are made up.

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

Not on npm yet, so it installs from source:

```bash
git clone https://github.com/ethanzhoucool/mobile-bisect
cd mobile-bisect
npm install
npm run build
npm link --workspace mobile-bisect   # optional, puts `mobile-bisect` on your PATH
```

Without the link, every command below is `node <repo>/packages/cli/dist/cli.js …`.

Two ways to see it work before a device is involved. Replay the scripted demo run:

```bash
mobile-bisect replay fixtures/demo-runs/orbit-checkout.jsonl
```

Or search your own repo's history against a simulated runtime:

```bash
cd ~/your-app
mobile-bisect run --good HEAD~20 --bad HEAD --dry-run \
  --expect "the order confirmation screen appears"
```

`--dry-run` executes the full search offline: real commits, real worktrees, real
report, with a fake runner standing in for the device. Then set up for real:

```bash
mobile-bisect init      # checks git, detects your framework, verifies Revyl auth
mobile-bisect run --good <sha> --bad <sha> --flow <file>
```

`init` walks you through authentication and writes a `mobile-bisect.config.ts`.

## The flow file

A flow is the thing every candidate is put through. `label` is ours, the human
line under the phone in the report; the rest of each step is Revyl's own step
body and is passed to the runner untouched.

```yaml
name: checkout-flow
expect: the order confirmation screen appears

steps:
  - label: Launch Orbit Store
    type: validation
    step_description: the home screen is showing, with a list of products

  - label: Tap "Place order"
    type: instructions
    step_description: tap the "Place order" button

  - label: Assert order confirmation
    type: validation
    step_description: the "Order confirmed" heading is visible
```

`type` is one of `instructions` (an agent acts), `validation` (an agent checks a
claim), `extraction`, or `manual` with a `step_type` such as `tap` or `swipe`
for a direct device verb. `step_description` is the text the device acts on.

A step body that does not fit one of those shapes is rejected when the file
loads. It used to be accepted and run as an instruction whose text was the
step's own label, which turned an assertion into an action and let the search
blame a commit for the result.

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

## The demo run

`fixtures/demo-runs/orbit-checkout.jsonl` is a 64-commit search that resolves in
6 rounds, over a scripted history for a commerce app called Orbit Store. The
planted regression is the one worth planting: a response-parsing refactor moves
the order payload under a `data` envelope while the navigation call still reads
the old path. The order request succeeds with a 200 either way. Only one build
reaches the confirmation screen.

That is the honest version of the problem, the failure is invisible to your
network layer and obvious on the screen.

```bash
mobile-bisect replay fixtures/demo-runs/orbit-checkout.jsonl
```

The event stream is scripted, not captured, so treat it as a picture of the
output and not as evidence about a real app. What is real is everything it
drives: the terminal UI, the live view and the report are the same code a cloud
run uses. For the search itself against real history, `--dry-run` on your own
repo is the honest test, it enumerates your commits and checks them out for
real.

The Expo app this run was written against is not in this repo. It carries its
own 64-commit history, which is the whole point of it, and a repo cannot hold
another repo's history without a submodule.

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
