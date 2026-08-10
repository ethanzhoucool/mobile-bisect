/**
 * Deterministic fixture generator for interface development.
 *
 * Produces a 64-commit bisect run that resolves in 6 rounds, matching the
 * shape the real runner emits. No randomness: same output every time.
 *
 *   node fixtures/generate.mjs > fixtures/demo-runs/orbit-checkout.jsonl
 */

const SUBJECTS = [
  'Release v1.4.0', 'Bump expo-router to 3.5.1', 'Add product grid skeleton loader',
  'Fix cart badge alignment on small screens', 'Extract PriceLabel component',
  'Tighten checkout button hit target', 'Add haptics to add-to-cart',
  'Memoize product list rows', 'Update seed catalog imagery', 'Rename OrderSummary props',
  'Add empty-cart illustration', 'Fix safe-area inset on Android', 'Upgrade react-native-svg',
  'Add coupon field placeholder copy', 'Refactor useCart into a reducer',
  'Cache product images with expo-image', 'Fix flatlist keyExtractor warning',
  'Add analytics event for view_product', 'Adjust card shadow tokens',
  'Split checkout screen into sections', 'Add loading state to Place order',
  'Fix currency formatting for cents', 'Remove unused ThemeProvider import',
  'Add pull-to-refresh on product list', 'Bump typescript to 5.6',
  'Tidy navigation types', 'Add SAVE10 coupon to seed data', 'Fix tab bar icon sizing',
  'Add product detail image carousel', 'Debounce coupon validation',
  'Extract api client into lib/api', 'Add request id to api logs',
  'Fix double-tap on Add to cart', 'Normalize product ids to strings',
  'Add order total breakdown row', 'Fix keyboard avoidance on checkout',
  'Reduce bundle size by trimming icons', 'Add skeleton for order summary',
  'Rename checkout route to /checkout', 'Add retry to failed image loads',
  'Preserve checkout navigation', 'Refactor order response handling',
  'Add order confirmation analytics', 'Tune confirmation screen spacing',
  'Fix status bar style on confirmation', 'Add share button to confirmation',
  'Update copy on order confirmation', 'Bump expo SDK patch',
  'Add e2e ids to checkout controls', 'Fix cart persistence across reloads',
  'Add product rating stars', 'Fix long product title truncation',
  'Add recently viewed section', 'Tune list scroll performance',
  'Add promo banner to home', 'Fix promo banner dismiss state',
  'Add address form validation', 'Improve error toast styling',
  'Add payment method icons', 'Fix coupon chip overflow',
  'Add order history stub screen', 'Tidy unused styles',
  'Bump dev client to 2.1.0', 'Update README screenshots',
];

const AUTHORS = ['maya.chen', 'dan.oketch', 'priya.raman', 'sam.whitfield'];

// Stable, hand-picked hashes so the demo video and docs always agree.
function shaFor(i) {
  const seed = (i * 2654435761) >>> 0;
  return seed.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

const commits = SUBJECTS.map((subject, index) => {
  const shortSha = index === 40 ? '7fa11c8' : index === 41 ? '8d4c2f1' : shaFor(index).slice(0, 7);
  const sha = index === 40
    ? '7fa11c8e0a1c4b9d2f7a6e3c5b8d1a4f9c2e7b60'
    : index === 41
      ? '8d4c2f19b3e7a5c0d8f2b6a4e9c1d7f3a5b8e204'
      : shaFor(index);
  return {
    sha,
    shortSha,
    subject,
    author: AUTHORS[index % AUTHORS.length],
    authoredAt: new Date(Date.UTC(2026, 5, 2, 9, 0, 0) + index * 5.5 * 3600 * 1000).toISOString(),
    index,
  };
});

const CULPRIT = 41;
const events = [];
// Fixture clock: advances by whatever each step "costs". Never wall-clock.
let clock = Date.UTC(2026, 7, 6, 16, 41, 0);
const at = (ms = 0) => (clock += ms, new Date(clock).toISOString());

const FLOW = [
  'Launch Orbit Store',
  'Open featured product',
  'Tap "Add to cart"',
  'Open cart',
  'Apply coupon SAVE10',
  'Tap "Place order"',
  'Assert order confirmation',
];

events.push({
  type: 'search.started',
  at: at(0),
  meta: {
    runId: 'orbit-checkout-demo',
    command: 'npx mobile-bisect --good v1.4.0 --bad HEAD --flow flows/checkout.yaml --expect "the order confirmation screen appears"',
    flowName: 'checkout-flow',
    goodRef: 'v1.4.0',
    badRef: 'HEAD',
    expect: 'the order confirmation screen appears',
    totalCommits: commits.length,
    plannedRounds: 6,
  },
  commits,
});

// Binary search over the unknown interior [1, 62]; 0 is known good, 63 known bad.
let lo = 1;
let hi = commits.length - 2;
let round = 0;

while (lo <= hi) {
  round += 1;
  const mid = Math.floor((lo + hi) / 2);
  const c = commits[mid];
  const isBad = mid >= CULPRIT;

  events.push({ type: 'round.started', at: at(400), round, activeRange: [lo, hi], candidateSha: c.sha });
  events.push({
    type: 'commit.running',
    at: at(1200),
    sha: c.sha,
    sessionId: `sess_${c.shortSha}`,
    streamUrl: `https://stream.revyl.ai/demo/${c.shortSha}`,
  });

  // A bad build still walks the whole flow — it just never lands on confirmation.
  FLOW.forEach((label, i) => {
    events.push({ type: 'flow.step', at: at(1600), sha: c.sha, index: i + 1, total: FLOW.length, label });
  });

  const durationMs = 42_000 + mid * 137;
  events.push({
    type: 'commit.completed',
    at: at(900),
    result: {
      sha: c.sha,
      subject: c.subject,
      author: c.author,
      state: isBad ? 'bad' : 'good',
      runId: `run_${c.shortSha}`,
      assertion: 'the order confirmation screen appears',
      assertionPassed: !isBad,
      reason: isBad
        ? 'POST /orders returned 200 but the app stayed on checkout. Order confirmation heading never appeared.'
        : 'Order confirmation heading appeared 1.2s after tapping Place order.',
      durationMs,
      attempt: 1,
      videoUrl: `https://artifacts.revyl.ai/demo/${c.shortSha}/run.mp4`,
      screenshots: [
        `https://artifacts.revyl.ai/demo/${c.shortSha}/step-6.png`,
        `https://artifacts.revyl.ai/demo/${c.shortSha}/step-7.png`,
      ],
      logsUrl: `https://artifacts.revyl.ai/demo/${c.shortSha}/logs.json`,
      networkUrl: `https://artifacts.revyl.ai/demo/${c.shortSha}/network.har`,
    },
  });

  if (isBad) hi = mid - 1;
  else lo = mid + 1;

  events.push({
    type: 'range.narrowed',
    at: at(500),
    round,
    activeRange: [lo, Math.max(lo, hi)],
    remaining: Math.max(0, hi - lo + 1),
  });
}

events.push({
  type: 'culprit.found',
  at: at(600),
  goodSha: commits[CULPRIT - 1].sha,
  badSha: commits[CULPRIT].sha,
  diagnosis:
    'POST /orders returned 200 in both builds. Navigation stopped after the response parser returned undefined.',
});
events.push({ type: 'report.ready', at: at(300), reportPath: '.mobile-bisect/runs/orbit-checkout-demo/report.html' });

process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
