// Online payment through the typed v2 API (backend/api). The browser never prices anything and never holds a provider secret:
//   POST /v1/payment-orders            { dueIds }  + Idempotency-Key   -> the order, priced by the server from what is owed now
//                                      { purpose: 'booking', unitId, amount } -> a prepayment: the booking claims it (paymentId) when it is made
//   (provider checkout in the browser: Razorpay Checkout, or the development simulator)
//   POST /v1/payment-orders/{id}/confirm  { providerPaymentRef, signature } -> the server checks the signature, asks the provider, settles
//   GET  /v1/payment-orders/{id}          -> status (the provider's webhook settles it too, whichever comes first)
import { PaymentGateway, OUTCOME } from './PaymentGateway.js';
import { apiFetch } from '../net/request.js';
import { ONLINE_MODES } from '../region/paymentModes.js';
import { orderOf } from '../storage/v2/v2map.js';

/** Razorpay's checkout script, loaded the first time it is needed (only when the server's provider is Razorpay). */
let razorpayScript = null;
function loadRazorpay() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Razorpay checkout needs a browser.'));
  if (window.Razorpay) return Promise.resolve();
  razorpayScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.async = true;
    s.onload = () => (window.Razorpay ? resolve() : reject(new Error('The Razorpay checkout did not start.')));
    s.onerror = () => { razorpayScript = null; reject(new Error('The Razorpay checkout could not be loaded - check the connection and try again.')); };
    document.head.appendChild(s);
  });
  return razorpayScript;
}

export default class V2Gateway extends PaymentGateway {
  constructor() { super({ id: 'v2', name: 'Online payment', methods: ONLINE_MODES }); this.live = true; }
  async #call(path, init = {}) {
    const res = await apiFetch(`/v1${path}`, init);
    let body = null; try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) { const e = new Error(body?.detail || `Payment service: ${res.status}`); e.status = res.status; e.code = body?.code; throw e; }
    return body;
  }
  async createOrder(req) {
    // one key per press of Pay: a network retry of THIS request gets the same order; a new attempt after a failure gets a new one
    const key = `pay-${crypto.randomUUID()}`;
    if (req.purpose === 'booking' || req.purpose === 'donation') {
      // paid before the booking exists: the server keeps the money as the unit's credit until the booking claims this payment
      const { unitIdByNo } = await import('../storage/v2/V2ApiAdapter.js');
      const unitId = await unitIdByNo(req.unit);
      if (!unitId) throw new Error(`Unit ${req.unit || '?'} is not known to the back end.`);
      return orderOf(await this.#call('/payment-orders', { method: 'POST', body: JSON.stringify({ purpose: req.purpose, unitId, amount: Number(req.amount).toFixed(2) }), headers: { 'Idempotency-Key': key } }));
    }
    if (req.purpose !== 'due') throw new Error(`"${req.purpose}" payments are not on the v2 back end yet.`);
    return orderOf(await this.#call('/payment-orders', { method: 'POST', body: JSON.stringify({ dueIds: req.refs }), headers: { 'Idempotency-Key': key } }));
  }
  async checkout(order, ui) {
    if (order.provider === 'simulated') {
      const res = ui ? await ui(order, this) : { outcome: OUTCOME.SUCCESS, method: ONLINE_MODES[0] };
      if (!res?.outcome || res.outcome === OUTCOME.PENDING) return res;
      const pay = await this.#call(`/dev/simulated-checkout/${encodeURIComponent(order.providerOrderRef)}?succeed=${res.outcome === OUTCOME.SUCCESS}`, { method: 'POST' });
      if (res.outcome === OUTCOME.SUCCESS) await this.confirm(order, pay.providerPaymentRef, pay.signature);
      return res;
    }
    if (order.provider === 'razorpay') {
      await loadRazorpay();
      const r = await new Promise((resolve) => {
        const rz = new window.Razorpay({ key: order.checkout.key, order_id: order.providerOrderRef, amount: Math.round(order.amount * 100), currency: order.currency,
          handler: (x) => resolve({ ok: true, x }), modal: { ondismiss: () => resolve({ ok: false }) } });
        rz.on('payment.failed', () => resolve({ ok: false, failed: true }));
        rz.open();
      });
      if (!r.ok) return r.failed ? { outcome: OUTCOME.FAILURE } : { outcome: null };
      await this.confirm(order, r.x.razorpay_payment_id, r.x.razorpay_signature);
      return { outcome: OUTCOME.SUCCESS };
    }
    throw new Error(`No checkout for provider ${order.provider}`);
  }
  confirm(order, providerPaymentRef, signature) {
    return this.#call(`/payment-orders/${encodeURIComponent(order.orderId)}/confirm`, { method: 'POST', body: JSON.stringify({ providerPaymentRef, signature }) });
  }
  async verifyWebhook() { return true; }   // verified on the server; the browser never sees a webhook
  async getOrder(orderId) { return orderOf(await this.#call(`/payment-orders/${encodeURIComponent(orderId)}`)); }
}
