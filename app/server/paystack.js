// Thin wrapper around Paystack's REST API using the built-in fetch — no SDK
// dependency. If PAYSTACK_SECRET_KEY isn't set, calls are simulated (logged,
// and echoing back whatever the caller claims) so the rest of the app —
// subscriptions, credit bundles, pay-per-lead — keeps working end-to-end in
// local dev and in the test suite without a real Paystack account. In
// production, a real secret key means every result here is a genuine,
// verified response from Paystack's own servers — the simulation path never
// runs once a real key is set.

const PAYSTACK_TIMEOUT_MS = 15000;

// On the live server a missing secret key must never turn into "every payment succeeded": refuse instead.
function noKey() {
  if (process.env.NODE_ENV === 'production') throw new Error('PAYSTACK_SECRET_KEY is not set on the live server; payments are refused.');
}

async function verifyTransaction(reference, { expectedAmountKobo } = {}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    noKey();
    console.log(`[paystack] PAYSTACK_SECRET_KEY not set — simulating a successful verify for reference "${reference}".`);
    return {
      status: true,
      simulated: true,
      data: {
        status: 'success',
        reference,
        amount: expectedAmountKobo ?? null,
        authorization: { authorization_code: `AUTH_sim_${reference}` },
      },
    };
  }
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
  });
  return res.json();
}

async function chargeAuthorization({ authorizationCode, email, amountKobo }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    noKey();
    const ref = `sim_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    console.log(`[paystack] PAYSTACK_SECRET_KEY not set — simulating a successful charge of ${amountKobo} kobo against ${authorizationCode}.`);
    return { status: true, simulated: true, data: { status: 'success', reference: ref, amount: amountKobo } };
  }
  const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization_code: authorizationCode, email, amount: amountKobo }),
    signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
  });
  return res.json();
}

// Paystack never refunds anything on its own — a successful transaction
// (like the card-verification charge in routes/billing.js) sits in the
// merchant's balance until *someone* calls this endpoint
// (https://paystack.com/docs/api/refund/). Calling it here, immediately
// after a successful charge, is what makes "always refunded" actually true
// for the cardholder without anyone at the business doing it by hand.
// Queued as `pending` on Paystack's side — it can take a few business days
// to actually land back on the customer's card/statement.
async function refundTransaction(reference, { amountKobo, customerNote, merchantNote } = {}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    noKey();
    console.log(`[paystack] PAYSTACK_SECRET_KEY not set — simulating a queued refund for reference "${reference}".`);
    return {
      status: true,
      simulated: true,
      data: { id: `sim_refund_${reference}`, amount: amountKobo ?? null, status: 'pending', currency: 'NGN' },
    };
  }
  const body = { transaction: reference };
  if (amountKobo != null) body.amount = amountKobo;
  if (customerNote) body.customer_note = customerNote;
  if (merchantNote) body.merchant_note = merchantNote;
  const res = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
  });
  return res.json();
}

module.exports = { verifyTransaction, chargeAuthorization, refundTransaction };
