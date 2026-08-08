# expo-bisect

**Git bisect, but it can see your app.**

You know the build is broken. You don't know which commit broke it. `expo-bisect` replays the failing flow on a cloud iPhone across your commit range and tells you the exact commit that caused it.

```bash
npx expo-bisect \
  --good v1.4.0 \
  --bad HEAD \
  --flow flows/checkout.yaml \
  --expect "the order confirmation screen appears"
```

```
FIRST BAD COMMIT

  8d4c2f1  Refactor order response handling
  priya.raman · 64 commits searched · 6 runs · 4m 21s

  POST /orders returned 200 in both builds.
  Navigation stopped after the response parser returned undefined.

  report → .expo-bisect/runs/2026-08-07-1641/report.html
```

---

## Why

Finding the commit that broke a mobile flow means checking out an old commit, rebundling, booting a simulator, tapping through the flow by hand, deciding whether the bug is there, and repeating. Six times, if you're disciplined about it. Usually more.

Git already has the binary search. What's missing is something that can look at a running app and decide *yes, it's broken here.* That's the part `expo-bisect` adds.

## How it works

1. `git rev-list --ancestry-path` enumerates the commits between your good and bad refs.
2. For each candidate the tool picks, it checks that commit out into a **temporary worktree** — your working tree is never touched.
3. It swaps the JavaScript bundle into one reusable Expo development client. No native rebuild per commit.
4. It replays your flow on a Revyl cloud device and evaluates your plain-language assertion.
5. Good, bad, or inconclusive — the search space halves, and it goes again.
6. When one commit remains, you get synchronized recordings of the last good and first bad builds, plus the network trace, logs, and diff.

64 commits resolve in 6 runs.

## Install

```bash
npx expo-bisect init      # checks git, your Expo project, and Revyl auth
npx expo-bisect run --good <sha> --bad <sha> --flow <file>
```

`init` walks you through authentication and writes an `expo-bisect.config.ts`. Try it against the included demo first:

```bash
cd examples/orbit-store
npx expo-bisect run --good v1.4.0 --bad HEAD --flow ../flows/checkout.yaml \
  --expect "the order confirmation screen appears" --dry-run
```

`--dry-run` executes the full search offline with a simulated runtime, so you can see the whole thing work before connecting a device.

## What v1 covers

Supported:

- Expo apps where the changes between good and bad are **JavaScript only**
- One reusable development client, one deterministic flow, one assertion
- Commit ranges from 2 to 64 candidates
- Good / bad / skipped / inconclusive, with one automatic retry
- Resume after an interrupted run
- A live browser view and a self-contained HTML report

Not yet:

- Native dependency changes between commits
- Android
- Multiple flows in one bisection
- Automatic code repair

## The demo app

`examples/orbit-store` is a small Expo commerce app with a real 64-commit history and one deliberately planted regression: a response-parsing refactor moves the order payload under a `data` envelope, but the navigation call still reads the old path. The order request succeeds with a 200 in both builds. Only one of them reaches the confirmation screen.

It's the honest version of the problem — the failure is invisible to your network layer and obvious on the screen.

The boundaries are real commits, not fixtures:

| | Commit | Subject |
|---|---|---|
| `v1.4.0` (good) | `c11cd02` | Release v1.4.0 |
| last good | `061d6c5` | Preserve checkout navigation |
| **first bad** | `82a753c` | Refactor order response handling |
| `HEAD` (bad) | `9cf9910` | Update README screenshots |

`examples/orbit-store/scripts/verify-bisect.sh` proves it independently with a plain `git bisect run` — it lands on index 41 in 6 steps without involving this tool at all.

## Safety

- The tool never runs `git checkout`, `reset`, `stash`, or `bisect` in your working tree. Candidates are checked out into detached worktrees and cleaned up on success, failure, and Ctrl-C.
- It refuses to start on a dirty tree unless you pass `--allow-dirty`, and even then it leaves your changes alone.
- Authentication is read from your existing Revyl CLI session or `REVYL_API_KEY`. Keys are never accepted as flags and never written to logs, events, state, or reports.

## Runtime

The cloud device layer is provided by [Revyl](https://revyl.com) — cloud devices, flow replay, video, screenshots, logs, and network traces. `expo-bisect` talks to it through one small interface (`MobileRuntimeRunner`), so the search logic stays readable and swappable. See [`docs/revyl-adapter.md`](docs/revyl-adapter.md).

Authenticate once during `init`. A free account covers the demo.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — packages, bisection state machine, event stream
- [`docs/visual-spec.md`](docs/visual-spec.md) — the report UI specification
- [`docs/revyl-adapter.md`](docs/revyl-adapter.md) — the cloud device integration

## License

MIT
