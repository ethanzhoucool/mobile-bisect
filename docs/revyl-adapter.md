# The Revyl adapter

`mobile-bisect` needs one thing from a mobile runtime: *run this flow against this
build and tell me whether the assertion held.* That contract is
`MobileRuntimeRunner` in `packages/core/src/types.ts` — five methods, no vendor
in sight, plus an optional sixth (`uploadBuild`) for the adapters that compile a
binary per candidate.

`@mobile-bisect/revyl-runner` is the implementation that talks to
[Revyl](https://revyl.ai). This document explains what it uses, why, and how to
replace it.

Everything below was verified against **Revyl CLI v0.1.71** by running the
commands and recording their output. The published CLI reference documents flags
only — it contains no response schemas and no exit-code contract — so nothing
here is inferred from documentation.

> Revyl cloud iOS devices are simulators. We say **cloud devices**, never "real
> devices".

---

## 1. Which Revyl CLI surface is used, and why

Revyl offers two ways to drive a device.

**`revyl test run <name>`** executes a test stored in your Revyl org. It is the
right tool for CI. It is the wrong tool for a bisect: the flow would have to be
uploaded and versioned server-side, it runs against a *build*, and a bisect does
not produce a build per commit — that is the whole point.

**`revyl device …`** provisions a raw cloud device session and issues one action
at a time. That is what this adapter uses, because a bisect needs to:

- keep **one** device alive across many candidates (`reuseSession`),
- swap the JavaScript between candidates without touching the native binary,
- observe **each step** as it happens so the report can render progress live,
- decide the verdict locally, from the raw envelope, rather than accepting a
  server-side pass/fail whose failure modes it cannot inspect.

`revyl dev` was considered and rejected. It is an excellent interactive loop —
it owns Metro startup, relay creation, dev-client install and the deep link —
but it is a long-lived foreground process bound to one worktree, and a bisect
wants N short-lived candidates against one device. The `expo` adapter does the
Metro half itself and hands this adapter a URL; the adapter does the device half. The
`revyl dev --tunnel '<dev-client link>'` flag is the supported seam for the same
idea and remains available if you would rather Revyl owned the relay.

### The core move, and the honest alternative

There are two ways a candidate reaches the device, matching the two kinds of
`PreparedCandidate` (see [`framework-adapters.md`](framework-adapters.md)).

**Bundle candidates.** The dev-client build is installed **once**. For each
candidate:

```
revyl device navigate --url "exp+<scheme>://expo-development-client/?url=<metro>"
```

The dev client fetches that candidate's bundle over the relay. No `eas build`,
no reinstall, no 15-minute native compile per commit. This is why an Expo
64-commit bisect finishes in the time one native build would take.

**Binary candidates.** A Swift or Kotlin commit has no such shortcut — the
change *is* native. The adapter compiles it, and this adapter registers the
result:

```
revyl build upload --json --yes --no-set-current \
    --file <artifact> --platform ios --version <shortSha>
revyl device install --json --build-version-id <BUILD_ID> -s <i>
```

`--no-set-current` is load-bearing. A bisect uploads one build per candidate,
and promoting each one would leave the app's current version pointing at
whichever commit the search happened to test last.

The build id comes back to the adapter via `noteUploaded`, so a resumed run
installs the same binary instead of compiling and uploading it again.

---

## 2. The exact commands issued per candidate

Session setup (once with `reuseSession`, otherwise once per candidate):

```
revyl device start --json --open=false --platform ios \
    --device-model "iPhone 16" --os-version "iOS 18.5" \
    --build-version-id <BUILD_ID> --timeout 900
```

`--open=false` matters: `--open` defaults to `true` and would pop a browser tab
per candidate.

Per candidate:

```
revyl device list --json                                            # resolve our index
revyl build upload --json --file <artifact> ...                     # only for a binary candidate
revyl device install --json --build-version-id <BUILD_ID> -s <i>    # only if a build is pinned
revyl device kill-app --json -s <i>                                 # only when resetState
revyl device navigate --json --url <DEV_CLIENT_DEEP_LINK> -s <i>    # the JS swap
revyl device validation "<error-screen check>" --json -s <i>        # did the bundle load?

revyl device list --json                                            # re-resolve before the flow
revyl device instruction "<step_description>" --json -s <i>         # per flow step…
revyl device tap --json --target "<target>" -s <i>                  # …or a low-level verb
revyl device validation "<the assertion>" --json -s <i>             # the verdict
revyl device logs --no-follow --json -s <i>                         # snapshot before teardown
```

Artifacts:

```
revyl device report --json --session-id <SESSION_ID>
revyl device report --json --session-id <SESSION_ID> --artifact network
revyl device report --json --session-id <SESSION_ID> --artifact network --download --output <path>
revyl device report --json --session-id <SESSION_ID> --artifact trace   --download --output <path>
revyl device report --json --session-id <SESSION_ID> --artifact perf    --download --output <path>
```

Teardown:

```
revyl device stop --json -s <i>
```

Every one of these is built as an **argv array** and run through `execFile`.
There is no shell anywhere in this package, so an assertion containing `"`, `;`
or `$(…)` is inert.

### Why `-s <index>`, never `device use` or `device attach`

`revyl device *` targets sessions by **local index**, not by session id. Indices
shift as sessions start and stop, and `device use` / `device attach` mutate a
*shared* local pointer that a concurrent bisect worker may be relying on. So the
adapter re-resolves its own index from `device list --json` (matching on
`session_id`) before each phase and passes `-s <i>` explicitly. Under
`--concurrency 4` this is the difference between four independent runs and four
runs stepping on each other.

---

## 3. Verdict classification

The single most load-bearing decision in the tool. A bisect is only as honest as
its ability to tell "the app is broken" from "the harness is broken".

**The rule: `fail` requires positive evidence that the app answered the question
and answered it wrong. Everything else is `inconclusive`.**

The two fields that make this decidable live in the same envelope:

```jsonc
{
  "success": false,              // CLI-level: did the command succeed end to end?
  "step_output": {
    "status": "success",         // WORKER health: did the step machinery run?
    "validation_result": false,  // APP answer: did the assertion hold?
    "reasoning": "We are looking for a purple order confirmation banner…"
  }
}
```

`status: "success"` with `validation_result: false` (exit code `1`, stderr
`Error: validation failed`) is a **real failing assertion**. Anything that
muddies `status` is infrastructure.

| What happened | Signal | Verdict |
| --- | --- | --- |
| Assertion held | exit `0`, `validation_result: true` | `pass` |
| Assertion did not hold | exit `1`, `Error: validation failed`, `status: "success"`, `validation_result: false` | **`fail`** |
| An action step could not complete, assertion still answered | action step non-zero; assertion asked anyway | `pass` / `fail` per the assertion |
| Assertion never ran | flow aborted on an infra error | `inconclusive` |
| Device would not start | `device start` non-zero (`failed to start session`) | `inconclusive` |
| App would not install | `Error: Installation failed` | `inconclusive` |
| Candidate bundle would not load | error-screen check answers `true` | `inconclusive` |
| Session died mid-flow | `no active session`, `session not found` | `inconclusive` |
| Backend/worker unreachable | `context deadline exceeded`, `proxy request failed`, `connection refused` | `inconclusive` |
| Auth rejected | `unauthorized`, `403`, `REVYL_API_KEY` | `inconclusive` |
| CLI call timed out | child killed on timeout | `inconclusive` |
| CLI binary could not be spawned | `ENOENT` / `EACCES` | `inconclusive` |
| Worker answered but could not evaluate | `status !== "success"` | `inconclusive` |
| Healthy envelope, no boolean | `validation_result` absent | `inconclusive` |
| Step this adapter cannot express (`if`, `while`, unknown `step_type`) | `UnsupportedStepError` | `inconclusive` |

`inconclusive` feeds `RetryPolicy` in core: run once more, and if it is still
inconclusive, mark the commit `skipped` and route the search around it — exactly
`git bisect skip` semantics.

### Two judgement calls worth arguing about

**A failed action step does not end the run.** Revyl's grounding is vision-based
and probabilistic. A single missed tap is genuinely ambiguous: it might be the
regression (the button is gone) or it might be a grounding miss. Treating it as
`inconclusive` would make the search skip *every* commit after a real regression
and converge on nothing. Treating it as `fail` would let one flaky tap convict
an innocent commit.

So the adapter does neither. When an action step cannot complete it stops
issuing further actions — no point burning device minutes on a flow that has
already diverged — and goes straight to the assertion, which is the only ground
truth it trusts. The assertion decides.

This is reinforced by a measured CLI behaviour: `revyl device tap --target "a
button that definitely does not exist"` returns `success: true` and taps a
guessed coordinate. Step exit codes are simply not a reliable signal. The
assertion is.

**A bundle that will not load is never a `fail`.** After pointing the dev client
at a candidate, the adapter asks one negative validation — *is the screen a
fatal loading error?* — and treats `true` as `inconclusive`. Without this, a
Metro hiccup on one candidate reads as "the app is broken at this commit" and
the bisect converges on the wrong SHA with total confidence. Configure with
`bundleErrorCheck: false | string`.

---

## 4. How auth is resolved

The adapter **never takes, constructs, stores or logs a credential.** There is
no API-key parameter anywhere in its public API, by design.

1. **Find the binary** — `resolveRevylCli()`: explicit `cliPath` →
   `REVYL_CLI` → `revyl` on `PATH` → `~/.revyl/bin/revyl`. Resolution is done
   in-process by probing `X_OK`; no `which` subshell.
2. **Let the CLI authenticate itself** — it reads
   `~/.revyl/credentials.json` (written by `revyl auth login`) or `REVYL_API_KEY`
   from the inherited environment. The adapter passes `process.env` through
   untouched and puts nothing on a command line.
3. **Check once, up front** — `checkRevylAuth()` runs
   `revyl auth status --json` and returns `{ ok, org, message }`, so a bisect
   fails in the first second rather than on commit 4 of 6.

Everything leaving the package — `onLog` lines, thrown error messages,
`RunResult.reason`, the persisted log snapshot — passes through
`redactWithEnv()` first. It scrubs credential-shaped `KEY=value` pairs,
`Authorization` headers, secret query params, JWTs, vendor-prefixed keys
(`rk_`, `rvl_`, `sk-`, `ghp_`, `xox…`), URL-embedded credentials, and
blanket-replaces the live value of any `*KEY*` / `*TOKEN*` / `*SECRET*` env var.

It deliberately **preserves AWS SigV4 query params** (`X-Amz-Credential`,
`X-Amz-Signature`, `X-Amz-Security-Token`). Those are scoped, expiring read
grants on the presigned artifact URLs the report renders; redacting them
silently breaks every screenshot in the report. A test asserts that a real
recorded report survives redaction with all of its URLs intact — this was a
genuine bug the test caught.

---

## 5. What artifacts are collected

`collectArtifacts(runId)` returns remote URLs and locally-downloaded paths.
Everything is best effort — `--artifact` answers *"not available for this
session"* whenever the worker produced no such capture, and a missing artifact
must never fail a candidate.

| `Artifacts` field | Where it comes from |
| --- | --- |
| `screenshots` | Presigned S3 URLs from `device report --json`: `screenshot_before_url` and `screenshot_after_url` for every grounded action, in execution order. Falls back to locally-written frames when the report has none. |
| `localPaths` | Run-dir-relative paths to the **downloaded copies** of those frames, plus per-step PNGs decoded from `step_output.image`, `network_requests.json.gz`, `perfetto_trace.perfetto-trace.gz`, `hardware_metrics.json.gz`, `device_logs.json`. |
| `networkUrl` | `device report --artifact network` (prints a presigned URL). |
| `logsUrl` | Unset — no remote URL exists for device-session logs. |
| `videoUrl` | Unset — see below. |

`screenshots` and `localPaths` are populated **both**, not either: the remote
URLs drive the live view while a run is in flight, and the local copies are what
the finished report renders.

### Why screenshots are downloaded eagerly

The frame URLs are presigned and **expire** — the recorded report carries
`X-Amz-Expires=3600`, and that is a server-side policy that can tighten without
notice. A six-round bisect that installs a build, replays a flow and retries an
inconclusive candidate routinely runs past that window, so by the time the
search resolves and the report renders, the frames from rounds 1 and 2 — often
the most interesting ones, because they bracket the culprit — are already dead.
The report's renderer inlines frames as base64 and would report *"N frame(s)
could not be inlined … fetch failed"*.

This matters more than it otherwise would because there is no retrievable video
URL (below), so these per-step frames are the evidence backbone of the final
comparison view rather than a nice-to-have.

So `collectArtifacts` pulls every frame to disk **at collect time, while the
links are still live**, rather than leaving URLs for the report to resolve
later. Files are named `step-<NN>-action-<AA>-{before,after}.png`, which sorts
lexicographically into execution order, so the sequence is recoverable from a
directory listing alone. Downloads run through a bounded pool (5 in flight by
default) with a per-request timeout (20s), so one hung fetch cannot wedge the
search.

Everything about this path is best effort and **cannot change a verdict**. A
frame that 403s because it already expired, a step that produced no screenshot,
a socket that resets, an environment with no global `fetch` — each is logged and
skipped, and `collectArtifacts` still resolves. Artifact collection is evidence
gathering; classification happens in `runFlow` and never consults it.

`localPaths` are relative to `runDir` (defaulting to the parent of
`artifactsDir`), per the `Artifacts` contract, so a run directory stays portable
when it is moved or zipped into a bug report. When no `artifactsDir` is
configured the runner writes nothing to disk at all and reports remote URLs
only, which keeps the package usable standalone; the CLI passes
`RunStore.artifactsDir`.

### Gaps found in the CLI

Measured, not assumed:

- **No session recording URL.** `device report --json` carries
  `video_timestamp_start` / `video_timestamp_end` on every step, so a recording
  demonstrably exists, but nothing exposes its URL. `videoUrl` is therefore left
  unset and the report falls back to screenshots. Putting the human `report_url`
  in `videoUrl` would break the report's `<video>` element, so we don't.
- **`revyl run <task_id>` rejects a device session.** A session's
  `workflow_run_id` returns *"no report found for task … check the task_id and
  whether the run has completed"*, both live and after teardown. The whole
  `revyl run {summary,logs,network,perf,trace}` family is scoped to
  `revyl test run` executions. Consequence: device logs must be read with
  `device logs --no-follow` **while the session is alive**, so `runFlow`
  snapshots them at the end and `collectArtifacts` only persists what it caught.
- **`device logs` follows forever by default.** `--no-follow` is mandatory or
  the bisect hangs. (It hung ours once.)
- **No container reset.** `resetState` maps to `device kill-app` — a cold JS
  start, but not a wiped `AsyncStorage` / `UserDefaults`.
- **`device start` does not echo device model or runtime.** The adapter reports
  what it requested; `device report` carries the authoritative values.
- **`device tap --target` does not fail on a missing target.** It returns
  `success: true` and taps a guess.

If Revyl later exposes a recording URL and accepts a session id in `revyl run`,
the only file that changes is `src/cli-adapter.ts`.

---

## 6. Swapping in a different runner

`MobileRuntimeRunner` is five methods and no vendor types:

```ts
export interface MobileRuntimeRunner {
  startSession(input: StartSessionInput): Promise<Session>;
  installOrLaunch(input: LaunchInput): Promise<void>;
  runFlow(input: RunFlowInput): Promise<RunResult>;
  collectArtifacts(runId: string): Promise<Artifacts>;
  stopSession(sessionId: string): Promise<void>;

  /** Optional: only needed for adapters that compile a binary per candidate. */
  uploadBuild?(input: UploadBuildInput): Promise<UploadedBuild>;
}
```

To target a different device cloud — or a local simulator, or a physical device
farm — implement those five and hand the instance to the bisector. Nothing in
`@mobile-bisect/core` imports this package.

Implement `uploadBuild` too if you want the `xcode` or `gradle` adapters to
work: without it they have an artifact and nowhere to put it, and the CLI says
so rather than failing mid-search. A runner without it still serves every
bundle-swapping framework.

What a replacement must get right:

1. **Return `inconclusive`, not `fail`, whenever the app did not answer.** This
   is the entire integrity of the search. Read the table in §3 and map your
   backend's failure modes onto it before writing anything else.
2. **Call `onStep(index, label)` with a 1-based index, before each step runs.**
   The report renders progress live from these.
3. **Never throw from `runFlow`** — return `{ verdict: 'inconclusive', reason }`.
   `installOrLaunch` and `startSession` *should* throw; throw something carrying
   the intended verdict (see `RevylError`) so callers do not parse messages.
4. **Make `runId` stable and resolvable.** `collectArtifacts(runId)` may be
   called after the session is gone.
5. **Redact.** Everything you emit ends up in `events.jsonl`, `state.json` and
   an HTML report a user may attach to a bug report.

`@mobile-bisect/core` ships `FakeRunner`, a complete in-memory implementation that
needs no cloud, no build and no network. It is the reference for the interface
and what `--demo` runs on. Read it before writing your own.

For testing an adapter, follow the pattern here: record real CLI output into
`fixtures/`, scrub it, and replay it through an injected executor
(`RevylRunnerOptions.executor`). The 101 tests in this package never touch the
cloud, and they exercise the error paths — including the ones where the CLI
writes nothing to stdout and only a message to stderr — which is where
classification bugs actually live.
