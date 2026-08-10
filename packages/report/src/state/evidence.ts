import type { CommitResult } from '../types.ts';

/**
 * Evidence shown in the drawer. A real run reads these out of
 * `runs/<id>/artifacts`; the fixture only carries artifact URLs, so the report
 * falls back to a derived view built from the runner's own reason/diagnosis
 * strings. Anything inferred rather than observed is labelled LIKELY CAUSE.
 */
export interface NetworkRow {
  method: string;
  path: string;
  status: number | '—';
  ms: number | '—';
  note?: string;
  flag?: 'key' | 'missing';
}

export interface LogRow {
  time: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  flag?: boolean;
}

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
  flag?: boolean;
}

export interface Evidence {
  network: NetworkRow[];
  logs: LogRow[];
  diffFile: string;
  diff: DiffLine[];
  regions: { title: string; detail: string }[];
  sources: { label: string; url?: string }[];
}

export interface EvidenceInput {
  bad?: CommitResult;
  good?: CommitResult;
  /** True when nothing in the report captured a device frame (fixture / dry run). */
  synthetic?: boolean;
}

/**
 * What the drawer can honestly show.
 *
 * The illustrated Orbit Store evidence below is the demo fixture's, and only
 * the fixture's. Rendering it for a real run put an HTTP call in the network
 * tab that the app never made, which is indistinguishable from evidence and
 * therefore worse than an empty tab. A real run gets what the runner actually
 * returned, and empty where it returned nothing.
 */
export function evidenceFor(input: EvidenceInput = {}): Evidence {
  const { bad, good, synthetic } = input;
  return synthetic ? fixtureEvidence(bad, good) : observedEvidence(bad, good);
}

function observedEvidence(bad?: CommitResult, good?: CommitResult): Evidence {
  const regions: { title: string; detail: string }[] = [];
  if (bad?.reason) {
    regions.push({ title: `first bad, ${bad.sha.slice(0, 7)}`, detail: bad.reason });
  }
  if (good?.reason) {
    regions.push({ title: `last good, ${good.sha.slice(0, 7)}`, detail: good.reason });
  }

  return {
    // The runner reports a verdict and frames, not a HAR or a log stream, so
    // these stay empty until it does. The tabs say so rather than inventing.
    network: [],
    logs: [],
    diffFile: '',
    diff: [],
    regions,
    sources: [
      { label: 'network', url: bad?.networkUrl },
      { label: 'logs', url: bad?.logsUrl },
      { label: 'video', url: bad?.videoUrl },
    ],
  };
}

/** The recorded Orbit Store demo. Never shown for a run that captured frames. */
function fixtureEvidence(bad?: CommitResult, good?: CommitResult): Evidence {
  return {

    network: [
      { method: 'GET', path: '/v1/products', status: 200, ms: 118 },
      { method: 'POST', path: '/v1/cart/items', status: 201, ms: 96 },
      { method: 'POST', path: '/v1/cart/coupon', status: 200, ms: 88 },
      {
        method: 'POST',
        path: '/v1/orders',
        status: 200,
        ms: 312,
        note: '{ "order": { "id": "A-10428", "status": "confirmed" } }',
        flag: 'key',
      },
      {
        method: 'GET',
        path: '/v1/orders/A-10428',
        status: '—',
        ms: '—',
        note: 'never sent on this build',
        flag: 'missing',
      },
    ],
    logs: [
      { time: '16:42:09.412', level: 'info', tag: 'checkout', message: 'placing order (items=1, total=133.20)' },
      { time: '16:42:09.724', level: 'info', tag: 'api', message: 'POST /v1/orders → 200 in 312ms' },
      { time: '16:42:09.731', level: 'warn', tag: 'orders', message: 'parseOrderResponse: orderId undefined', flag: true },
      { time: '16:42:09.733', level: 'error', tag: 'nav', message: 'router.push("/order/undefined") ignored — no matching route', flag: true },
      { time: '16:42:11.900', level: 'error', tag: 'flow', message: 'assertion failed: order confirmation heading not found' },
    ],
    diffFile: 'app/checkout/useSubmitOrder.ts',
    diff: [
      { kind: ' ', text: 'const res = await api.post("/v1/orders", payload);' },
      { kind: '-', text: 'const orderId = res.order.id;' },
      { kind: '+', text: 'const orderId = res.orderId;', flag: true },
      { kind: ' ', text: 'if (!orderId) return;            // silent bail-out' },
      { kind: ' ', text: 'router.push(`/order/${orderId}`);' },
    ],
    regions: [
      {
        title: 'Confirmation panel missing',
        detail: 'The order confirmation heading and order number never mount on the bad build.',
      },
      {
        title: 'CTA stuck in loading state',
        detail: 'Place order stays busy after a 200 response; the screen never navigates away.',
      },
    ],
    sources: [
      { label: 'network', url: bad?.networkUrl },
      { label: 'logs', url: bad?.logsUrl },
      { label: 'baseline', url: good?.runId ? `run ${good.runId}` : undefined },
    ],
  };
}
