import type { ReactNode } from 'react';

/**
 * Stand-in for the device video: a real (tiny) Orbit Store UI driven by the
 * flow step, so the report reads correctly before any recorded footage exists.
 * When a result carries a `videoUrl` the DeviceCard plays that instead.
 */
export type OrbitScreen =
  | 'home'
  | 'product'
  | 'product-added'
  | 'cart'
  | 'cart-coupon'
  | 'checkout'
  | 'confirmed'
  | 'stuck';

export function screenForStep(step: number, verdict?: 'pass' | 'fail'): OrbitScreen {
  const s = Math.max(0, Math.min(7, Math.floor(step)));
  switch (s) {
    case 0:
    case 1:
      return 'home';
    case 2:
      return 'product';
    case 3:
      return 'product-added';
    case 4:
      return 'cart';
    case 5:
      return 'cart-coupon';
    case 6:
      return 'checkout';
    default:
      return verdict === 'fail' ? 'stuck' : 'confirmed';
  }
}

const PRODUCTS = [
  { name: 'Aster Desk Lamp', price: '$148', tone: 'amber' },
  { name: 'Nimbus Speaker', price: '$92', tone: 'slate' },
  { name: 'Vero Lounge Chair', price: '$410', tone: 'sage' },
  { name: 'Halo Wall Mirror', price: '$220', tone: 'rose' },
];

function Thumb({ tone, big }: { tone: string; big?: boolean }) {
  return (
    <div className={`ob-thumb${big ? ' ob-thumb-big' : ''}`} data-tone={tone}>
      <svg viewBox="0 0 100 100" aria-hidden>
        {tone === 'amber' && (
          <>
            <path d="M50 22 L70 52 H30 Z" fill="rgba(255,255,255,.72)" />
            <rect x="47" y="52" width="6" height="24" fill="rgba(255,255,255,.5)" />
            <rect x="36" y="76" width="28" height="5" rx="2.5" fill="rgba(255,255,255,.5)" />
          </>
        )}
        {tone === 'slate' && (
          <>
            <rect x="32" y="24" width="36" height="52" rx="10" fill="rgba(255,255,255,.6)" />
            <circle cx="50" cy="44" r="9" fill="rgba(0,0,0,.18)" />
            <circle cx="50" cy="63" r="5" fill="rgba(0,0,0,.14)" />
          </>
        )}
        {tone === 'sage' && (
          <>
            <path d="M30 70 V44 a20 20 0 0 1 40 0 V70" fill="rgba(255,255,255,.62)" />
            <rect x="30" y="66" width="40" height="7" rx="3" fill="rgba(255,255,255,.45)" />
          </>
        )}
        {tone === 'rose' && (
          <>
            <circle cx="50" cy="50" r="22" fill="none" stroke="rgba(255,255,255,.65)" strokeWidth="7" />
            <circle cx="50" cy="50" r="11" fill="rgba(255,255,255,.35)" />
          </>
        )}
      </svg>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="ob-status">
      <span className="mono">9:41</span>
      <span className="ob-status-icons">
        <svg viewBox="0 0 22 12" aria-hidden>
          <rect x="0" y="7" width="3" height="5" rx="1" />
          <rect x="5" y="5" width="3" height="7" rx="1" />
          <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" opacity=".35" />
        </svg>
        <svg viewBox="0 0 24 12" aria-hidden>
          <rect x="0.5" y="1" width="18" height="10" rx="3" fill="none" strokeWidth="1.4" stroke="currentColor" />
          <rect x="2.4" y="2.9" width="12" height="6.2" rx="1.6" />
          <rect x="20.5" y="4" width="2" height="4" rx="1" />
        </svg>
      </span>
    </div>
  );
}

function TabBar({ cart, active }: { cart: number; active: 'shop' | 'cart' }) {
  return (
    <div className="ob-tabs">
      {(['shop', 'search', 'cart', 'you'] as const).map((k) => (
        <div key={k} className="ob-tab" data-on={k === active}>
          <div className="ob-tab-glyph" data-k={k}>
            {k === 'cart' && cart > 0 && <span className="ob-badge">{cart}</span>}
          </div>
          <span>{k}</span>
        </div>
      ))}
    </div>
  );
}

function Line({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <div className="ob-line" data-strong={!!strong} data-accent={!!accent}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function Screen({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="ob-screen" key={id}>
      {children}
    </div>
  );
}

export interface OrbitStoreProps {
  screen: OrbitScreen;
  /** Draw the pass/fail assertion outline over the region being asserted. */
  assert?: 'pass' | 'fail' | null;
  /** Semantic visual-diff overlay (final comparison only). */
  diff?: boolean;
}

export function OrbitStore({ screen, assert = null, diff = false }: OrbitStoreProps) {
  const cartCount = screen === 'home' || screen === 'product' ? 0 : 1;

  let body: ReactNode = null;
  if (screen === 'home') {
    body = (
      <Screen id="home">
        <div className="ob-head">
          <h1>Orbit</h1>
          <div className="ob-search">Search the store</div>
        </div>
        <div className="ob-grid">
          {PRODUCTS.map((p) => (
            <div className="ob-card" key={p.name}>
              <Thumb tone={p.tone} />
              <div className="ob-card-name">{p.name}</div>
              <div className="ob-card-price mono">{p.price}</div>
            </div>
          ))}
        </div>
      </Screen>
    );
  } else if (screen === 'product' || screen === 'product-added') {
    body = (
      <Screen id="product">
        <div className="ob-nav">
          <span className="ob-back" />
          <span>Lighting</span>
        </div>
        <Thumb tone="amber" big />
        <div className="ob-pd">
          <div className="ob-pd-name">Aster Desk Lamp</div>
          <div className="ob-pd-price mono">$148.00</div>
          <div className="ob-pd-sub">Brushed brass · Warm dimmable</div>
        </div>
        <div className={`ob-cta${screen === 'product-added' ? ' is-done' : ''}`}>
          {screen === 'product-added' ? 'Added' : 'Add to cart'}
        </div>
        {screen === 'product-added' && <div className="ob-toast">Added to cart</div>}
      </Screen>
    );
  } else if (screen === 'cart' || screen === 'cart-coupon') {
    const coupon = screen === 'cart-coupon';
    body = (
      <Screen id="cart">
        <div className="ob-nav">
          <span className="ob-back" />
          <span>Cart</span>
        </div>
        <div className="ob-row">
          <Thumb tone="amber" />
          <div>
            <div className="ob-row-name">Aster Desk Lamp</div>
            <div className="ob-row-sub">Qty 1</div>
          </div>
          <div className="ob-row-price mono">$148.00</div>
        </div>
        <div className={`ob-coupon${coupon ? ' is-on' : ''}`}>
          <span className="mono">SAVE10</span>
          <span>{coupon ? 'Applied' : 'Apply'}</span>
        </div>
        <div className="ob-summary">
          <Line label="Subtotal" value="$148.00" />
          {coupon && <Line label="SAVE10" value="−$14.80" accent />}
          <Line label="Shipping" value="Free" />
          <Line label="Total" value={coupon ? '$133.20' : '$148.00'} strong />
        </div>
        <div className="ob-cta">Checkout</div>
      </Screen>
    );
  } else if (screen === 'checkout' || screen === 'stuck') {
    body = (
      <Screen id="checkout">
        <div className="ob-nav">
          <span className="ob-back" />
          <span>Checkout</span>
        </div>
        <div className="ob-row">
          <Thumb tone="amber" />
          <div>
            <div className="ob-row-name">Aster Desk Lamp</div>
            <div className="ob-row-sub">Qty 1 · Arrives Jun 12</div>
          </div>
          <div className="ob-row-price mono">$148.00</div>
        </div>
        <div className="ob-block">
          <div className="ob-block-label">Deliver to</div>
          <div className="ob-block-value">128 Mission St, San Francisco</div>
        </div>
        <div className="ob-block">
          <div className="ob-block-label">Payment</div>
          <div className="ob-block-value mono">•••• •••• •••• 4242</div>
        </div>
        <div className="ob-summary">
          <Line label="Subtotal" value="$148.00" />
          <Line label="SAVE10" value="−$14.80" accent />
          <Line label="Total" value="$133.20" strong />
        </div>
        <div className="ob-note">Orders are charged when they ship.</div>
        <div
          className={`ob-cta ob-cta-order${screen === 'checkout' ? ' is-busy' : ''}`}
          data-assert={assert === 'fail' ? 'fail' : undefined}
        >
          {screen === 'checkout' ? <span className="ob-spinner" /> : 'Place order'}
        </div>
      </Screen>
    );
  } else {
    body = (
      <Screen id="confirmed">
        <div className="ob-confirm">
          <div className="ob-check">
            <svg viewBox="0 0 40 40" aria-hidden>
              <path d="M12 20.5 L17.5 26 L28 15" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="ob-confirm-head" data-assert={assert === 'pass' ? 'pass' : undefined}>
            Order confirmed
          </div>
          <div className="ob-confirm-sub mono">Order #A-10428</div>
        </div>
        <div className="ob-block">
          <div className="ob-block-label">Arriving</div>
          <div className="ob-block-value">Thursday, Jun 12</div>
        </div>
        <div className="ob-block">
          <div className="ob-block-label">Paid with</div>
          <div className="ob-block-value mono">•••• 4242</div>
        </div>
        <div className="ob-summary">
          <Line label="Aster Desk Lamp" value="$148.00" />
          <Line label="SAVE10" value="−$14.80" accent />
          <Line label="Total paid" value="$133.20" strong />
        </div>
        <div className="ob-note">A receipt was sent to maya@orbit.store</div>
        <div className="ob-cta ob-cta-ghost">View order</div>
      </Screen>
    );
  }

  return (
    <div className="ob" data-screen={screen}>
      <StatusBar />
      <div className="ob-body">{body}</div>
      {diff && (
        <div className="ob-diff">
          <div className="ob-diff-region" data-kind="missing" style={{ top: '12%', height: '36%' }}>
            <span>confirmation panel missing</span>
          </div>
          <div className="ob-diff-region" data-kind="stuck" style={{ top: '83%', height: '8.5%' }}>
            <span>cta still loading</span>
          </div>
        </div>
      )}
      <TabBar cart={cartCount} active={screen.startsWith('cart') ? 'cart' : 'shop'} />
    </div>
  );
}
