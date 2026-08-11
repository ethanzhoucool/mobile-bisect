# Architecture

## Shape

```
mobile-bisect/
  packages/
    cli/            command parsing, terminal UI, orchestration
    core/           bisection state machine, adapter contract, run store, diagnosis, fakes
    git/            ancestry enumeration, worktrees, cleanup, metadata
    expo-runner/    the `expo` adapter: dependency install, bundle prep, dev-client targeting
    native-runner/  the `xcode` and `gradle` adapters: compile, package, cache
    revyl-runner/   cloud device execution, build upload, flow replay, artifact collection
    report/         live web interface and static HTML report
  examples/
    orbit-store/    Expo demo app with a real 64-commit history
    flows/          example flow definitions
  fixtures/
    demo-runs/      recorded event streams for interface development
  docs/
```

`packages/core/src/types.ts` is the single shared contract. Nothing else is allowed to define these types, and no package imports another package's internals.

## The one idea

Git bisect already knows *which* commit to test next. It has no way to decide whether a commit is good or bad when "bad" means a screen didn't appear. `mobile-bisect` supplies that decision by running the app.

So the system is a search, a way to build, and a way to run, meeting at two narrow interfaces:

- **Search** (`core`, `git`), pure logic, no I/O beyond git. Fully testable offline.
- **Preparation** (`expo-runner`, `native-runner`), turning a commit into something installable, behind `FrameworkAdapter`.
- **Runtime** (`revyl-runner`), everything that touches a device, behind `MobileRuntimeRunner`.

`core` knows about neither Expo nor Xcode nor Gradle. It knows a candidate is
either a URL to open or an artifact to install, and that is the entire extent of
its opinion about mobile frameworks. See [`framework-adapters.md`](framework-adapters.md).

The CLI wires them together; the report observes.

## Bisection state machine

Candidates come from `git rev-list --ancestry-path <good>..<bad>`, oldest first, boundaries included. Index `0` is the known-good boundary and index `n-1` is the known-bad boundary, so the search only ever examines the interior `[1, n-2]`.

```
lo = 1, hi = n-2
while lo <= hi:
    mid = floor((lo + hi) / 2)
    verdict = run(commits[mid])
    good => lo = mid + 1
    bad  => hi = mid - 1
culprit  = commits[lo]
lastGood = commits[lo - 1]
```

For 64 commits that is 6 classification decisions, which is the acceptance criterion.

### Non-binary outcomes

A run that doesn't cleanly pass or fail must not corrupt the search:

| Outcome | Meaning | Effect on the range |
|---|---|---|
| `good` | Assertion passed | `lo = mid + 1` |
| `bad` | Assertion failed on a build that ran | `hi = mid - 1` |
| `inconclusive` | The run itself failed, device wouldn't boot, install failed, bundle wouldn't load | None. Retried once, then downgraded to `skipped` |
| `skipped` | Can't be classified | Try the nearest untested commit outward from `mid`, alternating `mid-1`, `mid+1`, `mid-2`, … within `[lo, hi]` |

The `bad` vs `inconclusive` distinction is what keeps the result honest. A commit that doesn't bundle is not evidence about the regression. Getting this wrong produces a confident, wrong answer, which is worse than no answer.

If every commit in the active range skips, the search ends unresolved and says so.

## Event stream

The search emits an append-only stream, consumed live by the report and persisted so a run can be reopened or replayed deterministically.

```ts
type BisectEvent =
  | { type: "search.started";   meta; commits }
  | { type: "round.started";    round; activeRange; candidateSha }
  | { type: "commit.running";   sha; streamUrl?; sessionId? }
  | { type: "flow.step";        sha; index; total; label }
  | { type: "commit.completed"; result }
  | { type: "range.narrowed";   round; activeRange; remaining }
  | { type: "culprit.found";    goodSha; badSha; diagnosis? }
  | { type: "report.ready";     reportPath }
  | { type: "search.failed";    message }
```

`activeRange` is a pair of inclusive indices into the `commits` array from `search.started`. That's all the report needs to drive the collapsing rail, it never recomputes the search.

Every event carries an `at` timestamp, which is what makes replay possible at arbitrary speed.

## Run directory

```
.mobile-bisect/
  runs/<run-id>/
    state.json      resumable snapshot, written atomically
    events.jsonl    append-only log
    report.html     self-contained static report
    artifacts/      downloaded video, screenshots, logs, network traces
  worktrees/<sha>/  transient candidate checkouts
```

`state.json` is written temp-then-rename so an interrupt can never leave a torn file. `resume` reloads it and continues from the correct round without re-running anything already classified.

## Candidate execution

Per candidate:

1. Create a detached git worktree at the candidate SHA.
2. Ask the adapter to prepare it. This happens **before** the device is started, so a commit that will not build never burns cloud device time.
3. Start a cloud device session.
4. Hand it the candidate: navigate to the bundle URL, or upload and install the artifact.
5. Reset the app to a known state.
6. Replay the flow, emitting `flow.step` as it goes.
7. Evaluate the assertion.
8. Collect artifacts, dispose the candidate, remove the worktree, record the result.

Step 2 is where the frameworks differ, and it is the only place they do.

**Expo** takes the shortcut: one native binary, many JavaScript bundles. It installs dependencies from the lockfile (cached by lockfile hash, so unchanged deps cost nothing across commits), starts Metro on an isolated port or exports a static bundle, and hands the dev client a deep link. Seconds per candidate.

That shortcut is a lie when the range contains native changes, the JavaScript would run against the wrong native modules, so the adapter's `precheck` rejects such a range up front rather than answering confidently and wrongly.

**Xcode and Gradle** do the honest thing and compile. Minutes per candidate rather than seconds, which binary search makes tolerable: 64 commits is 6 builds, not 64. Finished artifacts are cached by SHA, so retries, resumes, and the final comparison never rebuild; builds are serialised, because two compilers contending for the same cores are slower than one after the other.

## Working tree safety

The tool never runs `git checkout`, `git reset`, `git stash`, or `git bisect` against the user's tree. Every candidate checkout is a detached worktree under `.mobile-bisect/worktrees/`, removed on success, on failure, and on SIGINT/SIGTERM. Git commands are invoked through `execFile` with argument arrays, never string interpolation, so a ref containing shell metacharacters is inert.

A dirty working tree is refused by default. With `--allow-dirty` the run proceeds, and the uncommitted changes are still never touched.

## Secrets

Authentication is resolved from the existing Revyl CLI session or `REVYL_API_KEY`. There is no flag that accepts a key. Key-shaped material is redacted from log output, thrown errors, `events.jsonl`, `state.json`, and the report, a run directory is safe to attach to a bug report.

## Testing without a cloud

`FakeRunner` implements `MobileRuntimeRunner` with a configurable culprit SHA and optional flakiness. It makes the entire CLI runnable offline, which is what `--dry-run` uses. The report is developed against `fixtures/demo-runs/orbit-checkout.jsonl`, a recorded 64-commit run.

Mock data is fine for building the interface. The recorded launch demo is driven by real git history, real bundles, and real device runs.
