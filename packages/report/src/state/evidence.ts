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

export function evidenceFor(bad?: CommitResult, good?: CommitResult): Evidence {
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
