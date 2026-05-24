/**
 * JORD Golf — Stripe Connect helper.
 *
 * Wraps the Stripe SDK. Exposes:
 *   - `mode`        : 'stripe' | 'mock'  (mock when STRIPE_SECRET_KEY is missing)
 *   - `client`      : configured Stripe instance, or null in mock mode
 *   - `feeCents()`  : platform fee for a given amount (basis-points config)
 *   - `createConnectAccount({ admin })` : creates a Connect Express account
 *   - `createAccountLink({ accountId, refreshUrl, returnUrl })` : onboarding URL
 *   - `retrieveAccount(accountId)`
 *   - `createCheckoutSession({ ... })`
 *   - `verifyWebhook(rawBody, signatureHeader)` : returns parsed event
 *
 * Mock mode is the no-key state. All calls throw — registration code paths
 * gate on `mode === 'stripe'` so mock mode falls back to the test path.
 */

'use strict';

const Stripe = require('stripe');

const KEY      = process.env.STRIPE_SECRET_KEY || '';
const WHSECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FEE_BPS  = Number(process.env.STRIPE_PLATFORM_FEE_BPS || 300); // 300 = 3.00%

const mode   = KEY ? 'stripe' : 'mock';
const client = KEY ? new Stripe(KEY, { apiVersion: '2024-06-20' }) : null;

function feeCents(amountCents) {
  return Math.round((Number(amountCents) || 0) * FEE_BPS / 10000);
}

function assertLive() {
  if (mode !== 'stripe') throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
}

/**
 * Create a Connect Express account for an organizer.
 *   admin: { id, email, name }
 * Returns the Stripe Account object.
 */
async function createConnectAccount({ admin }) {
  assertLive();
  return client.accounts.create({
    type: 'express',
    email: admin.email,
    business_type: 'company',
    metadata: { jord_admin_id: admin.id },
    capabilities: {
      card_payments: { requested: true },
      transfers:     { requested: true },
    },
  });
}

/**
 * Create an Account Link for hosted onboarding. Stripe redirects the organizer
 * back to one of the URLs when done (or when the link expires).
 */
async function createAccountLink({ accountId, refreshUrl, returnUrl }) {
  assertLive();
  return client.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url:  returnUrl,
    type: 'account_onboarding',
  });
}

async function retrieveAccount(accountId) {
  assertLive();
  return client.accounts.retrieve(accountId);
}

/**
 * Map a Stripe Account to our four status flags.
 *   active:       charges + payouts enabled (ready to take money)
 *   pending:      details_submitted but Stripe still reviewing
 *   restricted:   currently_due / disabled_reason → needs more info
 */
function mapAccountStatus(account) {
  const out = {
    stripe_charges_enabled:   account.charges_enabled   ? 1 : 0,
    stripe_payouts_enabled:   account.payouts_enabled   ? 1 : 0,
    stripe_details_submitted: account.details_submitted ? 1 : 0,
  };
  if (account.charges_enabled && account.payouts_enabled) out.stripe_account_status = 'active';
  else if (account.details_submitted)                     out.stripe_account_status = 'pending';
  else                                                    out.stripe_account_status = 'restricted';
  return out;
}

/**
 * Create a Stripe Checkout Session that pays the connected account directly
 * (destination charge). The platform fee is taken from the gross.
 *
 *   amountCents       — gross paid by the buyer (package + fee)
 *   platformFeeCents  — JORD's cut (3%)
 *   connectedAccountId
 *   productName       — what the buyer sees on the Stripe page
 *   metadata          — registration_id, event_id, etc.
 *   buyerEmail
 *   successUrl, cancelUrl
 */
async function createCheckoutSession({
  amountCents, platformFeeCents, connectedAccountId,
  productName, productDescription, metadata, buyerEmail,
  successUrl, cancelUrl,
}) {
  assertLive();
  return client.checkout.sessions.create({
    mode: 'payment',
    customer_email: buyerEmail,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: productName,
          ...(productDescription ? { description: productDescription } : {}),
        },
      },
      quantity: 1,
    }],
    payment_intent_data: {
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: connectedAccountId },
    },
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata,
  });
}

/**
 * Verify a webhook signature and return the parsed event. Throws on bad sig.
 * `rawBody` must be the unparsed Buffer/string Express received (use raw
 * body-parser BEFORE express.json on the webhook route).
 */
function verifyWebhook(rawBody, signatureHeader) {
  assertLive();
  if (!WHSECRET) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  return client.webhooks.constructEvent(rawBody, signatureHeader, WHSECRET);
}

module.exports = {
  mode,
  client,
  FEE_BPS,
  feeCents,
  createConnectAccount,
  createAccountLink,
  retrieveAccount,
  mapAccountStatus,
  createCheckoutSession,
  verifyWebhook,
};
