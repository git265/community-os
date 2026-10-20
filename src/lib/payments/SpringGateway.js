// The production adapter: the browser never talks to Razorpay/Stripe's secret API. It talks to YOUR Spring Boot service, which
// holds the provider keys, prices the order, verifies webhook signatures and settles the records. Same interface as the
// simulator, so switching is `registerGateway(new SpringGateway({ id: 'razorpay', ... }))` + choosing it in Community setup.
//
//   POST {base}/payments/orders          { purpose, refs[], idempotencyKey, meta } -> { orderId, amount, currency, providerOrderId, publicKey }
//   POST {base}/payments/webhook/{id}    provider -> server only (HMAC verified there; not called from the browser)
//   GET  {base}/payments/orders/{id}     -> { status: Created|Paid|Failed|Pending, paymentId }
//   POST {base}/payments/refunds         { paymentId, amount, reason }
import { PaymentGateway, OUTCOME } from './PaymentGateway.js';
import { backendFetch } from '../storage/dataSource.js';
import { resolveSlug } from '../community.js';

export default class SpringGateway extends PaymentGateway {
  constructor({ id = 'razorpay', name = 'Razorpay', base, methods, sdk } = {}) {
    super({ id, name, methods }); this.base = base; this.sdk = sdk; this.live = true;
  }
  async #call(path, init) {
    const r = await backendFetch(path, init, resolveSlug(), this.base);
    if (!r.ok) throw new Error(`${this.name}: ${r.status} ${await r.text().catch(() => '')}`.trim());
    return r.json();
  }
  createOrder(req) { return this.#call('/payments/orders', { method: 'POST', body: JSON.stringify(req) }); }
  /** Provider SDK (Razorpay Checkout / Stripe Elements) is passed in as `sdk(order) => Promise<{success, paymentId}>`. */
  async checkout(order) {
    if (!this.sdk) throw new Error(`${this.name}: no checkout SDK is configured`);
    const res = await this.sdk(order);
    return { outcome: res?.success ? OUTCOME.SUCCESS : OUTCOME.FAILURE, paymentId: res?.paymentId };
  }
  async verifyWebhook() { return true; } // verified on the server; the browser never sees the webhook
  getOrder(orderId) { return this.#call(`/payments/orders/${encodeURIComponent(orderId)}`); }
  refund(paymentId, amount, reason) { return this.#call('/payments/refunds', { method: 'POST', body: JSON.stringify({ paymentId, amount, reason }) }); }
}
