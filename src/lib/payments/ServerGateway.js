// The gateway the app uses when the BACK END enforces sign-in: the server prices the order, takes the provider's webhook and settles bill, ledger
// entry and receipt in one transaction. The browser only starts an order, shows the provider's checkout, and reads the order's status.
//   POST /payments/orders        { purpose, refs[], meta } -> order (amount is set by the server)
//   GET  /payments/orders/{id}   -> { status: Created|Pending|Paid|Failed|Expired, paymentId, ... }
//   POST /payments/simulate/{id} development only: tells the pretend bank what to do (success | failure | pending)
import { PaymentGateway, OUTCOME } from './PaymentGateway.js';
import { backendFetch } from '../storage/dataSource.js';
import { resolveSlug } from '../community.js';
import { ONLINE_MODES } from '../region/paymentModes.js';

export default class ServerGateway extends PaymentGateway {
  constructor() { super({ id: 'server', name: 'Online payment', methods: ONLINE_MODES }); this.live = true; }
  async #call(path, init) {
    const r = await backendFetch(path, init, resolveSlug(), undefined);
    if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch { /* not JSON */ } const e = new Error(m || `Payment service: ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  createOrder(req) { const { amount, ...rest } = req; if (req.purpose === 'booking') rest.amount = amount; return this.#call('/payments/orders', { method: 'POST', body: JSON.stringify(rest) }); }   // the amount is NOT sent for bills: the server prices them (bookings carry it)
  /** What these bills cost right now, late fees included - the same pricing the order uses, but nothing is created. */
  quote(req) { return this.#call('/payments/orders', { method: 'POST', body: JSON.stringify({ ...req, quote: true }) }); }
  /** The pretend bank's checkout page (development). A real provider's SDK replaces this. */
  async checkout(order, ui) {
    const res = ui ? await ui(order, this) : { outcome: OUTCOME.SUCCESS, method: ONLINE_MODES[0] };
    if (!res?.outcome) return res;
    await this.#call(`/payments/simulate/${encodeURIComponent(order.orderId)}`, { method: 'POST', body: JSON.stringify({ outcome: res.outcome, method: res.method, deliverWebhook: !res.lostWebhook }) });
    return res;
  }
  async verifyWebhook() { return true; }   // verified on the server
  getOrder(orderId) { return this.#call(`/payments/orders/${encodeURIComponent(orderId)}`); }
}
