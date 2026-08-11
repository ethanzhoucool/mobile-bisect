# `@mobile-bisect/revyl-runner`

The bridge between `mobile-bisect` and a cloud device.

This package implements the `MobileRuntimeRunner` interface from
`@mobile-bisect/core` by shelling out to the [Revyl](https://revyl.ai) CLI. It
starts a cloud device, gets the candidate onto it, a deep link for a JavaScript
bundle, an upload-and-install for a compiled binary, walks a flow, asks one
natural-language assertion, and returns `pass` / `fail` / `inconclusive`.

Every fact about the Revyl CLI lives in exactly one file, `src/cli-adapter.ts`.
`src/runner.ts` reads as plain orchestration. If the CLI changes shape, only the
adapter and `fixtures/` move.

> Revyl cloud iOS devices are simulators. Throughout this project we say
> **cloud devices**, never "real devices".

## Install

```bash
npm install @mobile-bisect/revyl-runner
```

Requires the Revyl CLI on the machine (v0.1.71 or newer) and an authenticated
session.

## Usage

```ts
import { RevylRunner, checkRevylAuth } from '@mobile-bisect/revyl-runner';

const auth = await checkRevylAuth();
if (!auth.ok) throw new Error(auth.message);

const runner = new RevylRunner({
  buildId: 'BUILD_VERSION_ID',   // the dev-client build, installed once
  deviceModel: 'iPhone 16',
  osVersion: 'iOS 18.5',
  reuseSession: true,            // one device for the whole bisect
  onLog: (line) => process.stderr.write(`${line}\n`),
});

const session = await runner.startSession({ platform: 'ios' });
await runner.installOrLaunch({ sessionId: session.sessionId, bundleUrl, resetState: true });
const result = await runner.runFlow({ sessionId: session.sessionId, flow, assertion });
const artifacts = await runner.collectArtifacts(result.runId);
await runner.dispose();
```

## The verdict classification table

This is the part that keeps a bisect honest. `fail` requires **positive evidence
that the app answered the question and answered it wrong**. Everything else is
`inconclusive`, which the bisector retries once and then skips.

| What happened | Signal from the CLI | Verdict |
| --- | --- | --- |
| Assertion held | exit `0`, `success: true`, `step_output.validation_result: true` | `pass` |
| Assertion did not hold | exit `1`, stderr `Error: validation failed`, `success: false`, `step_output.status: "success"`, `validation_result: false` | **`fail`** |
| An action step could not be completed, but the assertion still answered | action step exits non-zero; the assertion is asked anyway | `pass` / `fail` per the assertion |
| Assertion never ran (flow aborted on an infra error) |, | `inconclusive` |
| Device would not start | `device start` non-zero, e.g. `failed to start session` | `inconclusive` |
| App would not install | `device install` non-zero, `Error: Installation failed` | `inconclusive` |
| Candidate bundle would not load | the error-screen check answers `true` | `inconclusive` |
| Session died mid-flow | `Error: no active session` / `session not found` | `inconclusive` |
| Worker or backend unreachable | `context deadline exceeded`, `proxy request failed`, `connection refused` | `inconclusive` |
| Auth rejected | `unauthorized` / `403` / `REVYL_API_KEY` | `inconclusive` |
| A CLI call timed out | `timedOut` | `inconclusive` |
| The CLI binary could not be spawned | `ENOENT` / `EACCES` | `inconclusive` |
| Worker answered but could not evaluate | `step_output.status !== "success"` | `inconclusive` |
| Healthy envelope with no boolean verdict | `validation_result` absent | `inconclusive` |
| Flow contains a step this adapter cannot express (`if`, `while`, unknown `step_type`) | thrown `UnsupportedStepError` | `inconclusive` |

The distinction that makes this work is two fields in one envelope:

- `step_output.status` is the **worker's** health, did the step machinery run?
- `step_output.validation_result` is the **app's** answer.

`status: "success"` with `validation_result: false` is a real failing assertion.
Anything that muddies `status` is infrastructure, and infrastructure never
convicts a commit.

### Two deliberate design choices

**An action step that fails does not abort the verdict.** Revyl's grounding is
vision-based and probabilistic; a single missed tap is ambiguous. So when an
action step cannot complete, the runner stops issuing further actions (no point
burning device minutes) and goes straight to the assertion, which is the only
ground truth it trusts. If the assertion then answers `false`, that is a `fail`.
If it cannot be evaluated, that is `inconclusive`. This is both honest and
convergent, treating every missed tap as `inconclusive` would make the search
skip every commit after a real regression.

**A bundle that will not load is never a `fail`.** After pointing the dev client
at a candidate, the runner asks one negative validation: *is the screen a fatal
loading error?* If yes, the candidate is `inconclusive`, because a Metro hiccup
must not get a commit blamed. Disable with `bundleErrorCheck: false` or replace
the wording with your own string.

## Commands issued per candidate

```
revyl device start --json --open=false --platform ios \
    --device-model "iPhone 16" --os-version "iOS 18.5" \
    --build-version-id <BUILD_ID> --timeout 900        # once, or once per candidate

revyl device list --json                                # resolve our session's index
revyl device install --json --build-version-id <BUILD_ID> -s <i>   # only if a build is pinned
revyl device kill-app --json -s <i>                     # only when resetState
revyl device navigate --json --url <DEV_CLIENT_DEEP_LINK> -s <i>   # the JS swap
revyl device validation "<error-screen check>" --json -s <i>

revyl device list --json                                # re-resolve before the flow
revyl device instruction "<step_description>" --json -s <i>        # per flow step
revyl device tap --json --target "<target>" -s <i>                 # …or a low-level verb
revyl device validation "<the assertion>" --json -s <i>            # the verdict
revyl device logs --no-follow --json -s <i>             # snapshot before the session ends

revyl device report --json --session-id <SESSION_ID>
revyl device report --json --session-id <SESSION_ID> --artifact network
revyl device report --json --session-id <SESSION_ID> --artifact network --download --output <path>
revyl device report --json --session-id <SESSION_ID> --artifact trace   --download --output <path>
revyl device report --json --session-id <SESSION_ID> --artifact perf    --download --output <path>

revyl device stop --json -s <i>
```

### Why `-s <index>` and not a session id

`revyl device *` targets sessions by **local index**, not by session id, and the
index shifts as sessions come and go. Under `--concurrency 4` a cached index
would eventually drive the wrong device. So the runner re-resolves the index
from `device list --json` before each phase, matching on `session_id`. It never
calls `device use` or `device attach`, both of which mutate shared local state
that another concurrent worker is relying on.

## Auth

The runner **never takes, constructs, stores or logs a credential.**

1. `resolveRevylCli()` finds the binary: an explicit `cliPath`, then `REVYL_CLI`,
   then `revyl` on `PATH`, then `~/.revyl/bin/revyl`.
2. The CLI reads its own session from `~/.revyl/credentials.json`, or
   `REVYL_API_KEY` from the inherited environment. Nothing is passed on a
   command line.
3. `checkRevylAuth()` runs `revyl auth status --json` once, up front, so a bisect
   fails in the first second rather than on commit 4.

Every string that leaves this package, `onLog` output, thrown error messages,
`RunResult.reason`, the persisted log snapshot, goes through `src/redact.ts`
first. It scrubs `KEY=value` pairs with credential-shaped names, `Authorization`
headers, secret query params, JWTs, vendor-prefixed keys (`rk_`, `rvl_`, `sk-`,
`ghp_`, …), URL-embedded credentials, and blanket-replaces the live value of any
`*KEY*`/`*TOKEN*`/`*SECRET*` env var.

It deliberately leaves AWS SigV4 query params (`X-Amz-Credential`,
`X-Amz-Signature`, `X-Amz-Security-Token`) alone, those are scoped, expiring
read grants on the artifact URLs the report renders, and redacting them silently
breaks every screenshot. There is a test that proves a real recorded report
survives redaction with its URLs intact.

## Artifacts

`collectArtifacts(runId)` returns both remote URLs and locally-downloaded paths.
Everything is best effort: `--artifact` answers *"not available for this
session"* whenever a capture was not produced, and a missing artifact must never
fail a candidate.

| Field | Source |
| --- | --- |
| `screenshots` | Presigned S3 URLs from `device report --json` (`screenshot_before_url` / `screenshot_after_url` for every grounded action, in execution order). Falls back to locally-written frames when the report has none. |
| `localPaths` | Run-dir-relative paths to the downloaded copies of those frames, plus per-step PNGs decoded from `step_output.image`, `network_requests.json.gz`, `perfetto_trace.perfetto-trace.gz`, `hardware_metrics.json.gz`, and `device_logs.json`. |
| `networkUrl` | `device report --artifact network` (prints a presigned URL). |
| `logsUrl` | Not set, see gaps below. |
| `videoUrl` | Not set, see gaps below. |

`screenshots` and `localPaths` are both populated: the remote URLs drive the
live view during a run, the local copies are what the finished report renders.

### Screenshots are downloaded eagerly, not lazily

Frame URLs are presigned and expire, the recorded report carries
`X-Amz-Expires=3600`. A six-round bisect with installs, flow replays and a retry
routinely outlives that, so leaving URLs for the report to fetch later would
mean the frames from the earliest rounds are already dead by the time the search
resolves. Since there is no retrievable video URL, these frames are the evidence
backbone of the report's final comparison view, not a nice-to-have.

So `collectArtifacts` downloads every frame at collect time, while the links are
live:

- named `step-<NN>-action-<AA>-{before,after}.png`, which sorts lexicographically
  into execution order, the sequence is recoverable from a directory listing;
- through a bounded pool (`downloadConcurrency`, default 5) with a per-request
  timeout (`artifactTimeoutMs`, default 20s), so a hung fetch cannot wedge the
  search;
- **never able to change a verdict.** An expired frame that 403s, a step with no
  screenshot, a reset socket, or a runtime with no global `fetch` is logged and
  skipped, and `collectArtifacts` still resolves. Classification happens in
  `runFlow` and never consults this path.

`localPaths` are relative to `runDir` (default: the parent of `artifactsDir`),
per the `Artifacts` contract, so a run directory survives being moved or zipped
into a bug report.

**With no `artifactsDir` the runner writes nothing to disk** and reports remote
URLs only, so the package stays usable standalone. The CLI passes
`RunStore.artifactsDir`:

```ts
new RevylRunner({
  artifactsDir: store.artifactsDir,   // e.g. runs/<id>/artifacts
  runDir: store.runDir,               // localPaths become artifacts/<runId>/…
});
```

## Known gaps in the CLI (verified against v0.1.71, not assumed from docs)

- **No session recording URL.** `device report --json` exposes
  `video_timestamp_start` / `video_timestamp_end` per step, so a recording
  exists, but no field carries its URL. `videoUrl` is therefore left unset; the
  report renders screenshots instead. Setting `videoUrl` to the human `report_url`
  would break the report's `<video>` element.
- **`revyl run <task_id>` does not accept a device session.** A session's
  `workflow_run_id` is rejected with *"no report found for task … check the
  task_id and whether the run has completed"*, both while the session is live
  and after it stops. `revyl run logs|network|perf|summary|trace` is for
  `revyl test run` executions only. Device-session logs must be read with
  `device logs --no-follow` **while the session is alive**, which is why the
  runner snapshots them at the end of `runFlow`.
- **`device logs` follows forever by default.** `--no-follow` is mandatory or
  the bisect hangs.
- **No container reset.** `resetState` maps to `device kill-app`, which
  guarantees a cold JS start but not a wiped `AsyncStorage` / `UserDefaults`.
- **`device tap --target` does not fail loudly.** A target that does not exist
  still returns `success: true` and taps a guessed coordinate. This is the main
  reason the final assertion, not step exit codes, is the source of truth.
- **`device start` does not echo the device model or runtime.** The runner
  reports what it asked for; `device report` carries the authoritative values.

## Flow steps

Steps use the Revyl-native block vocabulary, so a flow authored with
`revyl test create` pastes straight in. `label` is what the report renders.

```yaml
name: checkout
steps:
  - label: Open the featured product
    type: instructions
    step_description: Open the first product in the list
  - label: Tap "Place order"
    type: manual
    step_type: tap
    target: Place order button
  - label: Let the order settle
    type: manual
    step_type: wait
    step_description: "2"
expect: the order confirmation screen appears
```

Supported: `instructions` (default), `validation`, `extraction`, and `manual`
with `step_type` of `wait`, `navigate`, `kill_app`, `go_home`, `open_app`,
`back`, `key`, `shake`, `set_location`, `tap`, `double_tap`, `long_press`,
`type`, `swipe`, `clear_text`.

Not supported: `if` and `while`. Those are server-side test constructs with no
interpreter on a raw device session, so the adapter refuses them loudly rather
than skipping them silently.

## Tests

```bash
npx vitest run packages/revyl-runner
```

No test touches the cloud. Everything under `fixtures/` was captured from a live
Revyl CLI v0.1.71 session and then scrubbed of ids, emails and signatures, so
the parsers are exercised against real output shapes, including the error paths
where the CLI writes nothing to stdout and only a message to stderr.
