// Data access. Supabase when keys are set; an in-memory stand-in with the same
// rules otherwise (used by tests and for running offline).
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { config, live } from './config.mjs';

export class SlotTakenError extends Error {
  constructor() { super('That slot was just taken. Pick another one.'); this.code = 'slot_taken'; }
}

export function createStore() {
  return live.supabase ? supabaseStore() : memoryStore();
}

function supabaseStore() {
  const db = createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } });
  const one = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
  return {
    kind: 'supabase',
    createBusiness: (b) => one(db.from('businesses').insert(b).select().single()),
    getBusiness: (slug) => one(db.from('businesses').select().eq('slug', slug).maybeSingle()),
    getBusinessByAccount: (acct) => one(db.from('businesses').select().eq('stripe_account_id', acct).maybeSingle()),
    listBusinesses: () => one(db.from('businesses').select('slug,name,spec,created_at').order('created_at', { ascending: false }).limit(20)),
    async updateSpec(biz, spec, instruction) {
      const version = biz.spec_version + 1;
      await one(db.from('spec_versions').insert({ business_id: biz.id, version, instruction, spec }));
      return one(db.from('businesses').update({ spec, spec_version: version, name: spec.name }).eq('id', biz.id).select().single());
    },
    versions: (id) => one(db.from('spec_versions').select('version,instruction,created_at').eq('business_id', id).order('version', { ascending: false })),
    setStripe: (id, patch) => one(db.from('businesses').update(patch).eq('id', id).select().single()),
    busy: (id, from, to) => one(db.from('busy_slots').select('resource_key,starts_at,ends_at').eq('business_id', id).lt('starts_at', to).gt('ends_at', from)),
    async bookSlot(p) {
      const { data, error } = await db.rpc('book_slot', {
        p_business_id: p.business_id, p_resource_key: p.resource_key, p_offering_key: p.offering_key,
        p_starts_at: p.starts_at, p_ends_at: p.ends_at, p_customer_name: p.customer_name, p_customer_email: p.customer_email,
        p_answers: p.answers, p_amount_cents: p.amount_cents, p_fee_cents: p.fee_cents, p_currency: p.currency,
      });
      if (error?.code === '23P01') throw new SlotTakenError();
      if (error) throw new Error(error.message);
      return data;
    },
    attachSession: (id, sid) => one(db.from('bookings').update({ stripe_session_id: sid }).eq('id', id)),
    cancelBooking: (id) => one(db.from('bookings').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending')),
    markPaid: (sid) => one(db.from('bookings').update({ status: 'paid' }).eq('stripe_session_id', sid).neq('status', 'cancelled').select().maybeSingle()),
    getBooking: (id) => one(db.from('bookings').select().eq('id', id).maybeSingle()),
    listBookings: (id) => one(db.from('bookings').select().eq('business_id', id).neq('status', 'cancelled').order('starts_at').limit(200)),
    logAi: (id, u) => one(db.from('ai_calls').insert({ business_id: id, kind: u.kind, model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: u.cost_usd })),
    aiCalls: (id) => one(db.from('ai_calls').select('kind,model,input_tokens,output_tokens,cost_usd,created_at').eq('business_id', id).order('created_at')),
  };
}

function memoryStore() {
  const businesses = [];
  const versions = [];
  const bookings = [];
  const calls = [];
  const live = (b, now = Date.now()) => b.status === 'paid' || (b.status === 'pending' && new Date(b.hold_until) > now);
  return {
    kind: 'memory',
    async createBusiness(b) {
      if (businesses.some((x) => x.slug === b.slug)) throw new Error('duplicate key value violates unique constraint "businesses_slug_key"');
      const row = { id: randomUUID(), spec_version: 1, stripe_account_id: null, charges_enabled: false, created_at: new Date().toISOString(), ...b };
      businesses.push(row);
      return row;
    },
    getBusiness: async (slug) => businesses.find((b) => b.slug === slug) || null,
    getBusinessByAccount: async (acct) => businesses.find((b) => b.stripe_account_id === acct) || null,
    listBusinesses: async () => [...businesses].reverse().slice(0, 20),
    async updateSpec(biz, spec, instruction) {
      const row = businesses.find((b) => b.id === biz.id);
      row.spec_version += 1;
      versions.push({ business_id: row.id, version: row.spec_version, instruction, created_at: new Date().toISOString() });
      Object.assign(row, { spec, name: spec.name });
      return row;
    },
    versions: async (id) => versions.filter((v) => v.business_id === id).reverse(),
    async setStripe(id, patch) { const row = businesses.find((b) => b.id === id); Object.assign(row, patch); return row; },
    busy: async (id, from, to) => bookings.filter((b) => b.business_id === id && live(b) && b.starts_at < to && b.ends_at > from),
    async bookSlot(p) {
      const clash = bookings.some((b) => b.business_id === p.business_id && b.resource_key === p.resource_key && live(b)
        && new Date(b.starts_at) < new Date(p.ends_at) && new Date(b.ends_at) > new Date(p.starts_at));
      if (clash) throw new SlotTakenError();
      const row = { id: randomUUID(), status: 'pending', hold_until: new Date(Date.now() + 15 * 60000).toISOString(), stripe_session_id: null, created_at: new Date().toISOString(), ...p };
      bookings.push(row);
      return row;
    },
    async attachSession(id, sid) { bookings.find((b) => b.id === id).stripe_session_id = sid; },
    async cancelBooking(id) { const b = bookings.find((x) => x.id === id); if (b?.status === 'pending') b.status = 'cancelled'; },
    async markPaid(sid) { const b = bookings.find((x) => x.stripe_session_id === sid && x.status !== 'cancelled'); if (b) b.status = 'paid'; return b || null; },
    getBooking: async (id) => bookings.find((b) => b.id === id) || null,
    listBookings: async (id) => bookings.filter((b) => b.business_id === id && b.status !== 'cancelled').sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    async logAi(id, u) { calls.push({ business_id: id, ...u, created_at: new Date().toISOString() }); },
    aiCalls: async (id) => calls.filter((c) => c.business_id === id),
  };
}
