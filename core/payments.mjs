// Stripe Connect. Each business is a connected Express account; customers pay the
// business directly (destination charge) and the platform keeps a small application fee.
// Without a Stripe key, a local stand-in mimics the same flow so the demo still runs.
import Stripe from 'stripe';
import { config, live } from './config.mjs';

const stripe = live.stripe ? new Stripe(config.stripeSecretKey) : null;

export const feeFor = (amountCents) => Math.round((amountCents * config.platformFeePercent) / 100);

// Create (once) a connected account for a business and return an onboarding link.
export async function onboardingLink(biz) {
  if (!stripe) return { accountId: `acct_local_${biz.slug}`, url: `${config.baseUrl}/owner/${biz.slug}?connected=local`, local: true };
  let accountId = biz.stripe_account_id;
  if (!accountId || accountId.startsWith('acct_local_')) {
    // Accounts v2: Stripe requires it for new Connect platforms. The business is both a
    // merchant (card payments) and a recipient (receives our destination-charge transfers);
    // the platform collects fees and covers losses, as Express with destination charges expects.
    const account = await stripe.v2.core.accounts.create({
      contact_email: biz.owner_email || `owner+${biz.slug}@example.com`,
      display_name: biz.name,
      identity: { country: config.connectCountry },
      dashboard: 'express',
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
      metadata: { fitted_slug: biz.slug },
    });
    accountId = account.id;
  }
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        refresh_url: `${config.baseUrl}/api/businesses/${biz.slug}/connect/refresh`,
        return_url: `${config.baseUrl}/owner/${biz.slug}?connected=1`,
      },
    },
  });
  return { accountId, url: link.url, local: false };
}

export async function accountStatus(accountId) {
  if (!accountId) return { charges_enabled: false };
  if (!stripe || accountId.startsWith('acct_local_')) return { charges_enabled: true, local: true };
  // v1 retrieve still reads v2 accounts and reports charges_enabled once onboarding is done.
  const a = await stripe.accounts.retrieve(accountId);
  return { charges_enabled: Boolean(a.charges_enabled), details_submitted: Boolean(a.details_submitted) };
}

export async function dashboardLink(accountId) {
  if (!stripe || !accountId || accountId.startsWith('acct_local_')) return null;
  try { return (await stripe.accounts.createLoginLink(accountId)).url; } catch { return null; }
}

// Checkout for one booking. Money goes to the business; the fee stays with the platform.
export async function checkout({ biz, booking, offering, unitName }) {
  const success = `${config.baseUrl}/b/${biz.slug}/done?session_id={CHECKOUT_SESSION_ID}`;
  const cancel = `${config.baseUrl}/b/${biz.slug}?cancelled=${booking.id}`;
  if (!stripe || !biz.stripe_account_id || biz.stripe_account_id.startsWith('acct_local_')) {
    const id = `cs_local_${booking.id}`;
    return { id, url: `${config.baseUrl}/pay/local?session_id=${id}&slug=${biz.slug}`, local: true };
  }
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: biz.spec.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(booking.starts_at));
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: booking.customer_email || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: booking.currency,
        unit_amount: booking.amount_cents,
        product_data: { name: `${offering.name} · ${unitName}`, description: `${biz.name} · ${when}` },
      },
    }],
    payment_intent_data: {
      application_fee_amount: booking.fee_cents,
      transfer_data: { destination: biz.stripe_account_id },
      metadata: { booking_id: booking.id, business: biz.slug },
    },
    metadata: { booking_id: booking.id, business: biz.slug },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: success,
    cancel_url: cancel,
  });
  return { id: session.id, url: session.url, local: false };
}

// Is this Checkout Session paid? Used on the success redirect as well as by the webhook,
// so a booking confirms even when no webhook can reach a laptop.
export async function sessionPaid(sessionId) {
  if (sessionId.startsWith('cs_local_')) return true;
  if (!stripe) return false;
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  return s.payment_status === 'paid';
}

export function verifyWebhook(rawBody, signature) {
  if (!stripe || !config.stripeWebhookSecret) throw new Error('Webhook secret not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}
