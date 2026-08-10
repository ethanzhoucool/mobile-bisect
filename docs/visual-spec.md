# Visual specification

The report is not a test runner with rows of text. Its job is to make binary search *visible* — to communicate four things without a word of narration:

1. There are many possible commits.
2. The system is testing real application builds on real mobile runtimes.
3. The search space is shrinking, fast.
4. One exact commit caused the regression.

Everything below serves that. Design target is a 1440×900 desktop viewport that stays readable cropped to 16:9 video.

## Palette

| Token | Value |
|---|---|
| Canvas | `#0B0D10` |
| Elevated surface | `#12161C` |
| Hairline border | `#252B35` |
| Primary text | `#F4F7FB` |
| Secondary text | `#8C96A8` |
| Active blue | `#6EA8FE` |
| Good green | `#35D69A` |
| Bad red | `#FF5C72` |
| Skipped amber | `#F5B942` |
| Culprit glow | `#FF334F` |

## Type and spacing

Inter or Geist for labels and prose. Geist Mono (or an equivalent) for hashes, commands, logs, timings, and code. Fonts are bundled locally — the static report must render with no network.

**The smallest important text is 18px at 1440×900.** This is a hard floor, not a preference: the report gets uploaded to X, and X's encoder destroys thin low-contrast type. No hairline strokes on anything that carries meaning.

Rigid 8px spacing system. The canvas stays open and calm. The phones, the commit rail, and the final comparison carry the visual weight — everything else recedes. Avoid excessive panels, rounded cards, badges, and decorative gradients.

## Layout: four persistent regions

### 1. Command bar

A compact terminal-style strip, fixed for the whole run.

```
mobile-bisect  checkout-flow  v1.4.0..HEAD  64 commits  expected: order confirmation appears
                                                       ROUND 3 OF 6    8 COMMITS REMAIN
```

Values update with short number transitions. This is status, not theater — it should not look like a decorative fake terminal.

### 2. Commit rail — the centerpiece

A horizontal line of nodes beneath the command bar, one node per real commit in the ancestry path. 64 at the start.

| State | Appearance |
|---|---|
| Untested | Muted gray dot |
| Scheduled | Blue outline |
| Running | Blue fill, soft pulse |
| Good | Green fill |
| Bad | Red fill |
| Skipped | Amber ring |
| Culprit | Larger red node with a bright inner core |

Nodes show their abbreviated hash when focused or selected. Hover reveals subject, author, and timestamp.

**The collapse is the whole point.** When a round completes, commits outside the remaining range compress and fade to 20% opacity while the remaining range expands to occupy the center. Nodes *travel* to their new positions — measured, then animated (FLIP). They never unmount and remount. The viewer has to feel the search space collapsing.

**Eliminated commits are never deleted.** They stay on screen as compressed history so the audience can see where the search started and how far it has come.

A subtle bracket sits under the active range and animates inward on each narrowing.

### 3. Device stage

The center of the screen. Two device cards in a normal round: the current candidate, and the closest known good or bad boundary. An optional four-up parallel mode exists for the launch demo — the search stays binary internally, but multiple useful candidates can be evaluated concurrently when cloud capacity allows.

Each card carries:

- The live stream or recorded replay, in an iPhone frame
- Commit hash and subject above
- Current flow step below — `4 / 7  Tap "Place order"`
- A thin progress timeline
- A good / bad / inconclusive badge

**Keep the device visually dominant.** It sits directly on the dark canvas with a small amount of metadata around it, not inside a heavy dashboard card.

When the assertion is evaluated, briefly outline the relevant region inside the device: green around the confirmation heading on a pass, red around the stuck button or missing destination on a failure.

### 4. Evidence drawer

Collapsed until the culprit is found. Then it rises, revealing four tabs: **Visual**, **Network**, **Logs**, **Code**. Visual opens first.

## The final comparison

This is the payoff. Give it most of the screen.

```
LAST GOOD                              FIRST BAD
7fa11c8  Preserve checkout navigation  8d4c2f1  Refactor order response handling
```

One playhead drives both recordings, synchronized. At the breaking step, playback automatically slows to 0.5× for roughly one second.

At that moment: the good phone transitions to order confirmation, and the bad phone stays on checkout in a loading state. A thin connector line points from the failed screen region to the relevant evidence card.

A toggleable difference overlay uses a restrained heatmap — changed regions in pink or red, unchanged regions dimmed slightly. **No full-screen pixel snow.** Prefer semantic regions: the missing confirmation panel, the stuck call to action.

One concise diagnostic sentence sits below the phones:

```
POST /orders returned 200 in both builds.
Navigation stopped after the response parser returned undefined.
```

The Code tab opens the commit diff with the suspected line highlighted. **Do not claim root-cause certainty unless the logs and the diff support it.** When the cause is inferred, the section is labeled `LIKELY CAUSE`.

## Motion principles

1. **Preserve spatial continuity.** Commit nodes move into their new positions. They never disappear and reappear.
2. **Make narrowing feel fast.** Each completed round collapses in 400–600ms.
3. **Let device playback stay readable.** Do not animate the surrounding interface aggressively while the app is being tested.
4. **Color only when known.** Transition to green or red when a result arrives, never speculatively.
5. **Reserve the strongest animation for the culprit reveal.**

### Culprit reveal

About 1.2 seconds total:

1. The final two commit nodes separate slightly.
2. The tested candidate turns red.
3. All other nodes dim.
4. The culprit node expands to roughly 1.8× its normal size.
5. A red line travels from the node to the failed phone.
6. The evidence drawer rises.
7. The synchronized comparison starts automatically.

It should feel **conclusive, not celebratory**. No confetti, no particles, no bouncing icons. The tool found the commit. That's the emotion.

## Capture affordances

The interface is going to be screen-recorded, so recording is a feature, not an afterthought:

- A replay controller with play, pause, scrub, and **speed control** — the accelerated rounds in the launch video are real playback, not a post-production trick.
- `?chrome=off` hides dev affordances for clean capture.
- Deterministic playback: same event stream in, same frames out. No `Math.random()`, no wall-clock-dependent layout.

The opening frame of any capture must contain a moving device. Never open on a logo or a title card.

## Accessibility of meaning

The interface has to be understandable with the sound off, because it will be watched with the sound off. Nothing important may be carried by color alone — good and bad nodes differ in fill *and* the run result is stated in text under the device. Every state that matters has a label somewhere on screen.
