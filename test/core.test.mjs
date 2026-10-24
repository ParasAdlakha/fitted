// Runs with no keys: offline AI templates, in-memory store, local checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../core/spec.mjs';
import { TEMPLATES, pickTemplate } from '../core/templates.mjs';
import { availability, zonedTime, isoWeekday } from '../core/slots.mjs';
import { feeFor } from '../core/payments.mjs';

const spec = (name) => normalizeSpec(TEMPLATES[name]).spec;

test('all templates normalize without errors', () => {
  for (const name of Object.keys(TEMPLATES)) assert.deepEqual(normalizeSpec(TEMPLATES[name]).errors, [], name);
});

test('normalize repairs bad model output instead of trusting it', () => {
  const { spec: s, errors } = normalizeSpec({ name: 'X', accent: 'red', mode: 'nope', units: [{ name: 'A' }, { name: 'A' }], offerings: [{ name: 'Hour', price_cents: -5, duration_minutes: 0, unit_keys: ['ghost'] }], hours: { open: '25:00', close: '07:00' } });
  assert.deepEqual(errors, []);
  assert.equal(s.mode, 'resource');
  assert.equal(s.accent, '#4f46e5');
  assert.notEqual(s.units[0].key, s.units[1].key);
  assert.equal(s.offerings[0].price_cents, 0);
  assert.equal(s.offerings[0].duration_minutes, 5);
  assert.deepEqual(s.offerings[0].unit_keys, []);
  assert.equal(s.hours.open, '09:00');
});

test('empty spec is rejected', () => {
  assert.ok(normalizeSpec({}).errors.length >= 2);
});

test('offline AI picks the right kind of business', () => {
  assert.equal(pickTemplate('a spin studio with bikes').mode, 'class');
  assert.equal(pickTemplate('hair salon with three stylists').mode, 'staff');
  assert.equal(pickTemplate('padel club, 4 courts').mode, 'resource');
});

test('zoned time handles Berlin summer and winter time', () => {
  assert.equal(zonedTime('2026-07-01', '18:00', 'Europe/Berlin').toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(zonedTime('2026-12-01', '18:00', 'Europe/Berlin').toISOString(), '2026-12-01T17:00:00.000Z');
  assert.equal(isoWeekday('2026-10-24'), 6); // Saturday
});

const future = new Date('2026-01-01T00:00:00Z');

test('resource mode: slots across opening hours with peak pricing', () => {
  const s = spec('padel');
  const slots = availability(s, 'match-90', '2026-11-02', [], future);
  assert.equal(slots[0].start, '08:00');
  assert.equal(slots.at(-1).start, '21:30'); // 90 min must end by 23:00
  assert.equal(slots.find((x) => x.start === '10:00').price_cents, 3200);
  assert.equal(slots.find((x) => x.start === '18:00').price_cents, 4000);
  assert.equal(slots[0].free.length, 4);
});

test('busy bookings remove only overlapping units', () => {
  const s = spec('padel');
  const busy = [{ resource_key: 'court-2', starts_at: zonedTime('2026-11-02', '10:00', s.timezone).toISOString(), ends_at: zonedTime('2026-11-02', '11:30', s.timezone).toISOString() }];
  const slots = availability(s, 'match-90', '2026-11-02', busy, future);
  assert.deepEqual(slots.find((x) => x.start === '10:30').taken, ['court-2']);
  assert.deepEqual(slots.find((x) => x.start === '11:30').taken, []); // back-to-back is fine
  assert.deepEqual(slots.find((x) => x.start === '08:30').taken, []); // ends at 10:00 exactly
  assert.deepEqual(slots.find((x) => x.start === '09:00').taken, ['court-2']);
});

test('class mode: only scheduled sessions, every bike is a seat', () => {
  const s = spec('spin');
  const mon = availability(s, 'rhythm-45', '2026-11-02', [], future).map((x) => x.start);
  assert.deepEqual(mon, ['07:00', '18:30']);
  assert.equal(availability(s, 'climb-60', '2026-11-02', [], future).length, 0);
  assert.equal(availability(s, 'rhythm-45', '2026-11-02', [], future)[0].free.length, 18);
});

test('staff mode: closed days and staff restrictions', () => {
  const s = spec('salon');
  assert.equal(availability(s, 'cut', '2026-11-02', [], future).length, 0); // Monday closed
  assert.deepEqual(availability(s, 'colour', '2026-11-03', [], future)[0].free, ['mira']);
});

test('platform fee', () => {
  assert.equal(feeFor(3200), 96);
});

test('end to end: publish, book, block double booking, pay, dashboard', async () => {
  const { server } = await import('../server/server.mjs');
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.key ? { 'x-owner-key': opts.key } : {}) }, body: opts.body && JSON.stringify(opts.body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const gen = await call('/api/generate', { method: 'POST', body: { prompt: 'We are a padel club with four courts' } });
    assert.equal(gen.status, 200);
    const pub = await call('/api/businesses', { method: 'POST', body: { prompt: 'padel', spec: gen.body.spec, usage: gen.body.usage } });
    assert.equal(pub.status, 201);
    const { slug, owner_key } = pub.body;

    assert.equal((await call(`/api/businesses/${slug}/dashboard`)).status, 403);
    assert.equal((await call(`/api/businesses/${slug}/refine`, { method: 'POST', key: 'wrong', body: { instruction: 'x' } })).status, 403);

    const day = '2030-06-03';
    const booking = { offering_key: 'match-90', resource_key: 'court-1', date: day, start: '10:00', customer_name: 'Ana', customer_email: 'ana@example.com', answers: { rackets: 'Yes' } };
    const first = await call(`/api/businesses/${slug}/book`, { method: 'POST', body: booking });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const clash = await call(`/api/businesses/${slug}/book`, { method: 'POST', body: { ...booking, start: '10:30', customer_name: 'Ben', customer_email: 'ben@example.com' } });
    assert.equal(clash.status, 409);

    const avail = await call(`/api/businesses/${slug}/availability?date=${day}&offering=match-90`);
    assert.deepEqual(avail.body.slots.find((s) => s.start === '10:00').taken, ['court-1']);

    const sid = new URL(first.body.url).searchParams.get('session_id');
    const confirm = await call(`/api/bookings/confirm?session_id=${sid}`);
    assert.equal(confirm.body.booking.status, 'paid');

    const dash = await call(`/api/businesses/${slug}/dashboard`, { key: owner_key });
    assert.equal(dash.body.totals.paid_count, 1);
    assert.equal(dash.body.totals.gross_cents, 3600); // €32 + €4 indoor court
    assert.equal(dash.body.bookings[0].answers.rackets, 'Yes');
    assert.equal(JSON.stringify(dash.body.bookings).includes('ana@example.com'), false);

    const pubView = await call(`/api/businesses/${slug}`);
    assert.equal(pubView.body.owner_key, undefined);
  } finally {
    server.close();
  }
});

test('numbered seats are renumbered in reading order', () => {
  const units = [[0, 0, 1], [0, 1, 4], [1, 0, 2], [1, 1, 5]].map(([row, col, n]) => ({ key: `bike-${n}`, name: `Bike ${n}`, row, col, note: row === 0 ? 'Front row' : '', surcharge_cents: row === 0 ? 400 : 0 }));
  const { spec: s } = normalizeSpec({ ...TEMPLATES.spin, units });
  const front = s.units.filter((u) => u.row === 0).sort((a, b) => a.col - b.col);
  assert.deepEqual(front.map((u) => u.name), ['Bike 1', 'Bike 2']);
  assert.deepEqual(front.map((u) => u.surcharge_cents), [400, 400]);
});
