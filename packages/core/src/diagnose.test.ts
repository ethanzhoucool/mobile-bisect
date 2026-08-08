import { describe, expect, it } from 'vitest';

import { diagnose } from './diagnose.js';
import type { CommitResult } from './types.js';

const GOOD: CommitResult = {
  sha: '7fa11c8e0a1c4b9d2f7a6e3c5b8d1a4f9c2e7b60',
  subject: 'Preserve checkout navigation',
  author: 'maya.chen',
  state: 'good',
  assertion: 'the order confirmation screen appears',
  assertionPassed: true,
  reason: 'POST /orders returned 200. Order confirmation heading appeared 1.2s after tapping Place order.',
};

const BAD: CommitResult = {
  sha: '8d4c2f19b3e7a5c0d8f2b6a4e9c1d7f3a5b8e204',
  subject: 'Refactor order response handling',
  author: 'dan.oketch',
  state: 'bad',
  assertion: 'the order confirmation screen appears',
  assertionPassed: false,
  reason:
    'POST /orders returned 200 but the app stayed on checkout. Order confirmation heading never appeared.',
};

const GATED_NAV_DIFF = `diff --git a/app/checkout.tsx b/app/checkout.tsx
index 1111111..2222222 100644
--- a/app/checkout.tsx
+++ b/app/checkout.tsx
@@ -38,9 +38,11 @@ export default function Checkout() {
   async function placeOrder() {
     const res = await api.post('/orders', { items, coupon });
-    const order = await res.json();
-    router.push(\`/orders/\${order.id}\`);
+    const order = parseOrderResponse(await res.json());
+    if (order?.id) {
+      router.push(\`/orders/\${order.id}\`);
+    }
   }
`;

const REMOVED_NAV_DIFF = `diff --git a/app/checkout.tsx b/app/checkout.tsx
--- a/app/checkout.tsx
+++ b/app/checkout.tsx
@@ -40,7 +40,6 @@
   const order = await res.json();
-  router.push(\`/orders/\${order.id}\`);
   setLoading(false);
`;

const NOISY_DIFF = `diff --git a/app/checkout.tsx b/app/checkout.tsx
--- a/app/checkout.tsx
+++ b/app/checkout.tsx
@@ -10,6 +10,6 @@
-  router.push('/confirm');
+  navigateToConfirm();
diff --git a/lib/api.ts b/lib/api.ts
--- a/lib/api.ts
+++ b/lib/api.ts
@@ -4,5 +4,5 @@
-  return res.json();
+  return res.json().catch(() => null);
`;

describe('diagnose', () => {
  it('asserts a root cause when one file gates navigation on a parsed value', () => {
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff: GATED_NAV_DIFF });
    expect(d.likely).toBe(false);
    expect(d.sentence).toBe(
      'POST /orders returned 200 in both builds. Navigation stopped after the response parser returned undefined.',
    );
    expect(d.suspectLines?.[0]).toMatchObject({ file: 'app/checkout.tsx' });
    expect(d.suspectLines!.length).toBeGreaterThan(0);
  });

  it('drops the shared-request clause when the two runs do not agree', () => {
    const d = diagnose({
      lastGood: { ...GOOD, reason: 'Order confirmation heading appeared.' },
      firstBad: BAD,
      diff: GATED_NAV_DIFF,
    });
    expect(d.likely).toBe(false);
    expect(d.sentence).toBe('Navigation stopped after the response parser returned undefined.');
  });

  it('names the removed navigation call, with its line', () => {
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff: REMOVED_NAV_DIFF });
    expect(d.likely).toBe(false);
    expect(d.sentence).toContain('POST /orders returned 200 in both builds.');
    expect(d.sentence).toContain('app/checkout.tsx:41');
    expect(d.sentence).toContain('was removed');
  });

  it('hedges when the change is spread over several files', () => {
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff: NOISY_DIFF });
    expect(d.likely).toBe(true);
    expect(d.sentence).toContain('2 files changed');
    expect(d.sentence).toContain('"Refactor order response handling"');
    expect(d.suspectLines?.length).toBeGreaterThan(1);
  });

  it('hedges when the diff shows nothing to point at', () => {
    const d = diagnose({
      lastGood: GOOD,
      firstBad: BAD,
      diff: '',
      expect: 'the order confirmation screen appears',
    });
    expect(d.likely).toBe(true);
    expect(d.sentence).toContain('does not point at a single cause');
    expect(d.sentence).toContain('the assertion "the order confirmation screen appears"');
    expect(d.suspectLines).toBeUndefined();
  });

  it('hedges and says so when a boundary was never a clean verdict', () => {
    const d = diagnose({
      lastGood: GOOD,
      firstBad: { ...BAD, state: 'skipped' },
      diff: GATED_NAV_DIFF,
    });
    expect(d.likely).toBe(true);
    expect(d.sentence).toContain('re-run those two commits');
  });

  // The Orbit Store regression: the request still succeeds, only the envelope
  // key moved. This is the canonical case the whole demo is built around.
  it('finds a renamed response-envelope key in an api file', () => {
    const diff = [
      'diff --git a/src/lib/api/orders.ts b/src/lib/api/orders.ts',
      '--- a/src/lib/api/orders.ts',
      '+++ b/src/lib/api/orders.ts',
      '@@ -129,8 +129,9 @@',
      ' export function parseOrderResponse(raw: ServerOrderJson): OrderResponse {',
      '   const order = raw.order;',
      '+  // Envelope now matches the rest of the API.',
      '   return {',
      '-    order: {',
      '+    data: {',
      '       id: order.id,',
    ].join('\n');
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff });
    // 133 is the added `data: {` in this hunk. It must rank above the removed
    // `order: {`, because "start at file:line" is read against the bad commit
    // where the old line number points at whatever now sits there.
    expect(d.suspectLines?.[0]).toEqual({ file: 'src/lib/api/orders.ts', line: 133 });
    expect(d.sentence).toContain('src/lib/api/orders.ts:133');
  });

  it('does not treat a bare data key outside an api file as a suspect', () => {
    const diff = [
      'diff --git a/src/screens/Home.tsx b/src/screens/Home.tsx',
      '--- a/src/screens/Home.tsx',
      '+++ b/src/screens/Home.tsx',
      '@@ -10,3 +10,3 @@',
      '-    data: [],',
      '+    data: items,',
    ].join('\n');
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff });
    expect(d.suspectLines ?? []).toHaveLength(0);
  });

  it('caps suspect lines at five and dedupes them', () => {
    const many = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,9 @@'].concat(
      Array.from({ length: 9 }, (_, i) => `+  router.push('/p${i}');`),
    );
    const d = diagnose({ lastGood: GOOD, firstBad: BAD, diff: many.join('\n') });
    expect(d.suspectLines).toHaveLength(5);
    expect(new Set(d.suspectLines!.map((s) => `${s.file}:${s.line}`)).size).toBe(5);
  });
});
