// Online payment gateway contract (NOT connected yet).
// Today the owner's "Pay" button in PayDue.jsx marks the bill paid with a generated reference (demo mode).
// With a real provider (Razorpay, PayU, Cashfree, BillDesk…) the flow becomes:
//   1. createOrder(due)      -> POST /payments/orders   { dueId }                  -> { orderId, amount, keyId }   (server prices the bill; never trust the client amount)
//   2. the provider's checkout collects the money in the browser
//   3. the provider calls the server webhook POST /payments/webhook (signature verified) -> server marks the due Paid, writes the ledger credit, issues the receipt
//   4. the browser polls GET /dues/{id} until status = Paid
// The webhook is the only thing allowed to mark a due paid online; the browser callback is just a UX hint.
export const gateway = {
  connected: false,
  async createOrder() { throw new Error('No payment gateway is connected for this community yet'); },
};
