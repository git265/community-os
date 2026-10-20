// A pretend provider that behaves like a real one: creates orders, shows a hosted-checkout page, then sends a SIGNED webhook
// that PaymentService verifies and settles - exactly the path Razorpay/Stripe use against Spring Boot. Nothing leaves the browser.
// Test hooks: choose Success / Failure / Pending on the fake checkout page.
import { PaymentGateway, OUTCOME, ORDER_STATUS } from './PaymentGateway.js';
import { ONLINE_MODES } from '../region/paymentModes.js';

const SECRET = 'simulated-webhook-secret'; // a real secret lives only on the server
const KEY = 'communityos:gw:orders';
const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ } };
const rid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

export async function hmac(secret, text) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default class SimulatedGateway extends PaymentGateway {
  constructor() { super({ id: 'simulated', name: 'Demo gateway (simulated)', methods: ONLINE_MODES }); }

  async createOrder(req) {
    const orders = read();
    const existing = Object.values(orders).find((o) => o.idempotencyKey && o.idempotencyKey === req.idempotencyKey && o.status !== ORDER_STATUS.FAILED);
    if (existing) return existing; // safe retry: same key, same order
    const order = { orderId: rid('ORD'), amount: Number(req.amount) || 0, currency: req.currency || 'INR', status: ORDER_STATUS.CREATED, purpose: req.purpose, refs: req.refs || [], unit: req.unit || '', payer: req.payer || '', description: req.description || '', meta: req.meta || {}, idempotencyKey: req.idempotencyKey || '', createdAt: new Date().toISOString(), attempts: 0 };
    orders[order.orderId] = order; write(orders);
    return order;
  }

  /** The fake hosted page is drawn by <GatewayCheckout/>; `ui` is its promise-returning opener. */
  async checkout(order, ui) { return ui ? ui(order, this) : { outcome: OUTCOME.SUCCESS, method: ONLINE_MODES[0] || 'Card' }; }

  /** The provider's server-to-server call. Builds a signed event for the outcome the payer chose. */
  async buildWebhook(order, outcome, method = ONLINE_MODES[0] || 'Card') {
    const orders = read(); const o = orders[order.orderId] || order;
    o.attempts = (o.attempts || 0) + 1; orders[o.orderId] = o; write(orders);
    const type = outcome === OUTCOME.SUCCESS ? 'payment.captured' : outcome === OUTCOME.FAILURE ? 'payment.failed' : 'payment.pending';
    const event = { id: rid('EVT'), type, orderId: o.orderId, paymentId: rid('PAY'), amount: o.amount, currency: o.currency, method, at: new Date().toISOString() };
    const raw = JSON.stringify(event);
    return { raw, signature: await hmac(SECRET, raw) };
  }

  async verifyWebhook(raw, signature) { return signature === await hmac(SECRET, raw); }

  async getOrder(orderId) { return read()[orderId] || null; }

  /** Called by PaymentService after it has processed an event, so getOrder() reflects the truth. */
  async markOrder(orderId, patch) { const o = read(); if (o[orderId]) { o[orderId] = { ...o[orderId], ...patch }; write(o); } return o[orderId]; }

  async refund(paymentId, amount, reason) { return { refundId: rid('RFD'), paymentId, amount, reason, status: 'processed' }; }
}
