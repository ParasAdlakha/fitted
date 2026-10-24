// HTTP server: pages, JSON API, Stripe webhook. node:http only, no framework.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, live } from '../core/config.mjs';
import { createStore, SlotTakenError } from '../core/store.mjs';
import { generateSpec, refineSpec } from '../core/ai.mjs';
import { normalizeSpec, slugify } from '../core/spec.mjs';
import { availability, unitsFor } from '../core/slots.mjs';
import * as pay from '../core/payments.mjs';
import { seed } from '../core/seed.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
export const store = createStore();

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, fail) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', fail); });
const readJson = async (req) => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };
const page = async (res, file) => { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(await readFile(join(PUBLIC, file))); };

async function loadBiz(slug) {
  const biz = await store.getBusiness(slug);
  if (!biz) { const e = new Error('No such business'); e.status = 404; throw e; }
  return biz;
}

// Public view of a business: never the owner's email or prompt.
const publicBiz = (b) => ({ slug: b.slug, name: b.name, spec: b.spec, spec_version: b.spec_version, payments_ready: Boolean(b.stripe_account_id && b.charges_enabled) });

// Owner actions need the key handed out at publish time (kept in the owner's browser).
function requireOwner(req, biz) {
  const given = Buffer.from(String(req.headers['x-owner-key'] || ''));
  const want = Buffer.from(String(biz.owner_key || ''));
  if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) {
    const e = new Error('Owner key required'); e.status = 403; throw e;
  }
}

async function uniqueSlug(name) {
  const base = slugify(name) || 'business';
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${base}-${i + 1}` : base;
    if (!(await store.getBusiness(slug))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const routes = [
  ['GET', /^\/api\/status$/, async (req, res) => json(res, 200, { live, store: store.kind, model: live.ai ? config.model : 'offline-template', fee_percent: config.platformFeePercent })],
  ['GET', /^\/api\/businesses$/, async (req, res) => json(res, 200, (await store.listBusinesses()).map((b) => ({ slug: b.slug, name: b.name, emoji: b.spec.emoji, vertical: b.spec.vertical, mode: b.spec.mode }))) ],

  // 1. Owner describes the business -> AI drafts a spec (not saved yet).
  ['POST', /^\/api\/generate$/, async (req, res) => {
    const { prompt } = await readJson(req);
    if (!prompt || prompt.trim().length < 10) return json(res, 400, { error: 'Describe your business in a sentence or two.' });
    json(res, 200, await generateSpec(prompt.slice(0, 2000)));
  }],

  // 2. Owner publishes the draft -> a business row in Supabase.
  ['POST', /^\/api\/businesses$/, async (req, res) => {
    const { prompt, spec: draft, owner_email, usage } = await readJson(req);
    const { spec, errors } = normalizeSpec(draft);
    if (errors.length) return json(res, 400, { error: errors.join('; ') });
    const owner_key = randomBytes(18).toString('base64url');
    const biz = await store.createBusiness({ slug: await uniqueSlug(spec.name), owner_key, name: spec.name, owner_email: owner_email || null, prompt: String(prompt || '').slice(0, 2000), spec });
    if (usage) await store.logAi(biz.id, { kind: 'generate', model: String(usage.model), input_tokens: +usage.input_tokens || 0, output_tokens: +usage.output_tokens || 0, cost_usd: +usage.cost_usd || 0 });
    json(res, 201, { slug: biz.slug, owner_key });
  }],

  ['GET', /^\/api\/businesses\/([\w-]+)$/, async (req, res, [slug]) => json(res, 200, publicBiz(await loadBiz(slug)))],

  // Owner changes the product in plain words; every change is a new version.
  ['POST', /^\/api\/businesses\/([\w-]+)\/refine$/, async (req, res, [slug]) => {
    const biz = await loadBiz(slug);
    requireOwner(req, biz);
    const { instruction } = await readJson(req);
    if (!instruction?.trim()) return json(res, 400, { error: 'Say what to change.' });
    const out = await refineSpec(biz.spec, instruction.slice(0, 1000));
    if (out.errors.length) return json(res, 422, { error: out.errors.join('; ') });
    const updated = await store.updateSpec(biz, out.spec, instruction.slice(0, 1000));
    await store.logAi(biz.id, out.usage);
    json(res, 200, { spec: updated.spec, spec_version: updated.spec_version, usage: out.usage });
  }],

  ['GET', /^\/api\/businesses\/([\w-]+)\/availability$/, async (req, res, [slug], url) => {
    const biz = await loadBiz(slug);
    const day = url.searchParams.get('date');
    const offering = url.searchParams.get('offering') || biz.spec.offerings[0]?.key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return json(res, 400, { error: 'date=YYYY-MM-DD' });
    const from = new Date(`${day}T00:00:00Z`); from.setUTCHours(-14);
    const to = new Date(`${day}T00:00:00Z`); to.setUTCHours(38);
    const busy = await store.busy(biz.id, from.toISOString(), to.toISOString());
    json(res, 200, { date: day, offering, slots: availability(biz.spec, offering, day, busy) });
  }],

  // 3. Customer picks a unit and a time -> hold in Postgres -> Stripe Checkout.
  ['POST', /^\/api\/businesses\/([\w-]+)\/book$/, async (req, res, [slug]) => {
    const biz = await loadBiz(slug);
    const b = await readJson(req);
    const offering = biz.spec.offerings.find((o) => o.key === b.offering_key);
    if (!offering) return json(res, 400, { error: 'Unknown offering' });
    const unit = unitsFor(biz.spec, offering).find((u) => u.key === b.resource_key);
    if (!unit) return json(res, 400, { error: 'Unknown unit' });
    const slot = availability(biz.spec, offering.key, b.date, []).find((s) => s.start === b.start);
    if (!slot || slot.past) return json(res, 400, { error: 'That time is not bookable' });
    const amount = slot.price_cents + (unit.surcharge_cents || 0);
    if (!b.customer_name?.trim() || !/^\S+@\S+\.\S+$/.test(b.customer_email || '')) return json(res, 400, { error: 'Name and a valid email, please.' });
    const answers = Object.fromEntries(biz.spec.questions.map((q) => [q.key, String(b.answers?.[q.key] ?? '').slice(0, 200)]));
    let booking;
    try {
      booking = await store.bookSlot({
        business_id: biz.id, resource_key: unit.key, offering_key: offering.key, starts_at: slot.starts_at, ends_at: slot.ends_at,
        customer_name: b.customer_name.trim().slice(0, 80), customer_email: b.customer_email.trim().slice(0, 120), answers,
        amount_cents: amount, fee_cents: pay.feeFor(amount), currency: biz.spec.currency,
      });
    } catch (e) {
      if (e instanceof SlotTakenError) return json(res, 409, { error: e.message });
      throw e;
    }
    try {
      const session = await pay.checkout({ biz, booking, offering, unitName: unit.name });
      await store.attachSession(booking.id, session.id);
      json(res, 200, { url: session.url, booking_id: booking.id });
    } catch (e) {
      await store.cancelBooking(booking.id);
      throw e;
    }
  }],

  ['GET', /^\/api\/bookings\/confirm$/, async (req, res, _, url) => {
    const sid = url.searchParams.get('session_id') || '';
    if (!(await pay.sessionPaid(sid))) return json(res, 402, { error: 'Payment not completed' });
    const booking = await store.markPaid(sid);
    if (!booking) return json(res, 404, { error: 'Booking not found' });
    json(res, 200, { booking: { id: booking.id, resource_key: booking.resource_key, offering_key: booking.offering_key, starts_at: booking.starts_at, ends_at: booking.ends_at, amount_cents: booking.amount_cents, currency: booking.currency, status: booking.status } });
  }],

  // 4. Owner connects Stripe -> Express onboarding.
  ['POST', /^\/api\/businesses\/([\w-]+)\/connect$/, async (req, res, [slug]) => {
    const biz = await loadBiz(slug);
    requireOwner(req, biz);
    const link = await pay.onboardingLink(biz);
    const status = link.local ? { charges_enabled: true } : await pay.accountStatus(link.accountId);
    await store.setStripe(biz.id, { stripe_account_id: link.accountId, charges_enabled: status.charges_enabled });
    json(res, 200, { url: link.url, local: link.local });
  }],
  ['GET', /^\/api\/businesses\/([\w-]+)\/connect\/refresh$/, async (req, res, [slug]) => {
    const link = await pay.onboardingLink(await loadBiz(slug));
    res.writeHead(302, { location: link.url }); res.end();
  }],

  ['GET', /^\/api\/businesses\/([\w-]+)\/dashboard$/, async (req, res, [slug]) => {
    let biz = await loadBiz(slug);
    requireOwner(req, biz);
    if (biz.stripe_account_id && !biz.charges_enabled) {
      const s = await pay.accountStatus(biz.stripe_account_id);
      if (s.charges_enabled) biz = await store.setStripe(biz.id, { charges_enabled: true });
    }
    const [bookings, calls, versions, stripeDashboard] = await Promise.all([
      store.listBookings(biz.id), store.aiCalls(biz.id), store.versions(biz.id), pay.dashboardLink(biz.stripe_account_id),
    ]);
    const paid = bookings.filter((b) => b.status === 'paid');
    json(res, 200, {
      ...publicBiz(biz), owner_email: biz.owner_email, prompt: biz.prompt,
      stripe: { account_id: biz.stripe_account_id, charges_enabled: biz.charges_enabled, dashboard: stripeDashboard },
      bookings: bookings.map(({ id, resource_key, offering_key, starts_at, ends_at, status, customer_name, amount_cents, fee_cents, answers }) => ({ id, resource_key, offering_key, starts_at, ends_at, status, customer_name, amount_cents, fee_cents, answers })),
      totals: { paid_count: paid.length, gross_cents: paid.reduce((a, b) => a + b.amount_cents, 0), fee_cents: paid.reduce((a, b) => a + b.fee_cents, 0) },
      ai: { calls, cost_usd: calls.reduce((a, c) => a + Number(c.cost_usd), 0) },
      versions,
    });
  }],

  ['POST', /^\/webhooks\/stripe$/, async (req, res) => {
    let event;
    try { event = pay.verifyWebhook(await readBody(req), req.headers['stripe-signature']); } catch (e) { return json(res, 400, { error: e.message }); }
    if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') await store.markPaid(event.data.object.id);
    if (event.type === 'checkout.session.expired') {
      const id = event.data.object.metadata?.booking_id;
      if (id) await store.cancelBooking(id);
    }
    if (event.type === 'account.updated') {
      const acct = event.data.object;
      const biz = await store.getBusinessByAccount(acct.id);
      if (biz) await store.setStripe(biz.id, { charges_enabled: Boolean(acct.charges_enabled) });
    }
    json(res, 200, { received: true });
  }],

  ['GET', /^\/b\/[\w-]+(\/done)?$/, () => (req, res) => page(res, 'book.html')],
  ['GET', /^\/owner\/[\w-]+$/, () => (req, res) => page(res, 'owner.html')],
  ['GET', /^\/pay\/local$/, () => (req, res) => page(res, 'pay-local.html')],
];

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return await page(res, 'index.html');
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (!m || method !== req.method) continue;
      const out = await handler(req, res, m.slice(1), url);
      if (typeof out === 'function') await out(req, res);
      return;
    }
    // static assets
    const file = normalize(join(PUBLIC, url.pathname));
    if (req.method === 'GET' && file.startsWith(PUBLIC)) {
      try { const data = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); return res.end(data); } catch {}
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  server.listen(config.port, async () => {
    console.log(`Fitted on ${config.baseUrl}`);
    console.log(`  store: ${store.kind} · stripe: ${live.stripe ? 'live (test mode keys)' : 'local stand-in'} · ai: ${live.ai ? config.model : 'offline templates'}`);
    // The in-memory store starts empty on every restart; give it the demo businesses.
    if (store.kind === 'memory') for (const b of await seed(store)) console.log(`  ${b.spec.emoji} ${config.baseUrl}/owner/${b.slug}?key=${b.owner_key}`);
  });
}
