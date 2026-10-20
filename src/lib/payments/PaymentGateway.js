// PaymentGateway - the contract every online payment provider implements (Razorpay, Stripe, PayU, Cashfree ... or the simulator).
import { ONLINE_MODES } from '../region/paymentModes.js';
// The app only ever talks to this interface (through PaymentService), never to a provider SDK, so changing provider or country
// is a registry entry, not a code change in billing, bookings or donations.
//
// Money flow (identical for every provider - this is also the Spring Boot contract, see docs/ARCHITECTURE.md):
//   1. createOrder(request)   server prices the order from the record ids and returns { orderId, amount, currency, ... }
//   2. checkout(order)        the provider's hosted page / SDK collects the money in the browser -> { outcome }
//   3. webhook                the provider calls the server: signed event -> verifyWebhook() -> settle the records (idempotent)
//   4. getOrder(orderId)      the browser reads the final status (the webhook, not the browser, is the source of truth)
export const OUTCOME = { SUCCESS: 'success', FAILURE: 'failure', PENDING: 'pending' };
export const ORDER_STATUS = { CREATED: 'Created', PAID: 'Paid', FAILED: 'Failed', PENDING: 'Pending' };

/**
 * @typedef {Object} OrderRequest
 * @property {'due'|'booking'|'donation'|string} purpose   which settler finishes the job after payment
 * @property {string[]} refs        record ids being paid (dues, booking, pledge ...)
 * @property {number} amount        in major units (the server must re-price; never trust this)
 * @property {string} currency      ISO code, from the community's region
 * @property {string} [unit] @property {string} [payer] @property {string} [description]
 * @property {Object} [meta]        anything the settler needs (e.g. { useCredit: true })
 * @property {string} idempotencyKey  same key => same order (safe retries)
 */
export class PaymentGateway {
  /** @param {{id:string,name:string,methods?:string[]}} info */
  constructor(info) { this.id = info.id; this.name = info.name; this.methods = info.methods || ONLINE_MODES; this.live = false; }
  /** @param {OrderRequest} req @returns {Promise<{orderId:string,amount:number,currency:string,status:string}>} */
  async createOrder(/* req */) { throw new Error(`${this.name}: createOrder is not implemented`); }
  /** Opens the provider's checkout. In the simulator the UI shows a fake hosted page; real providers return after their SDK closes. */
  async checkout(/* order, ui */) { throw new Error(`${this.name}: checkout is not implemented`); }
  /** @returns {Promise<boolean>} true when the signature matches the provider's secret. Runs on the SERVER in production. */
  async verifyWebhook(/* rawBody, signature */) { throw new Error(`${this.name}: verifyWebhook is not implemented`); }
  async getOrder(/* orderId */) { throw new Error(`${this.name}: getOrder is not implemented`); }
  async refund(/* paymentId, amount, reason */) { throw new Error(`${this.name}: refund is not implemented`); }
}
