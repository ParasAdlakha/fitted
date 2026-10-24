// The spec is the whole product. The AI writes one; the engine renders and books from it.
// Three modes cover most of the real economy:
//   resource  book a unit for a length of time      (padel courts, studios, boats)
//   class     take a seat in a scheduled session     (spin bikes, yoga mats, workshop places)
//   staff     book a person for a service            (stylists, therapists, tutors)

const str = { type: 'string' };
const int = { type: 'integer' };
const nullable = (t) => ({ type: [t.type, 'null'] });
const hhmm = { type: 'string', description: '24h time, HH:MM' };
const obj = (properties) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});

// Strict JSON schema, used as the model's structured output format.
export const SPEC_SCHEMA = obj({
  name: str,
  tagline: { type: 'string', description: 'One line a customer sees under the name' },
  vertical: { type: 'string', description: 'e.g. padel club, spin studio, hair salon' },
  emoji: str,
  accent: { type: 'string', description: 'Brand colour as #rrggbb, readable on white' },
  currency: { type: 'string', enum: ['eur', 'gbp', 'usd', 'chf'] },
  timezone: { type: 'string', description: 'IANA zone, e.g. Europe/Berlin' },
  mode: { type: 'string', enum: ['resource', 'class', 'staff'] },
  unit_label: { type: 'string', description: 'What one bookable unit is called: Court, Bike, Stylist' },
  units: {
    type: 'array',
    items: obj({
      key: { type: 'string', description: 'short lowercase id, e.g. court-1, bike-12, anna' },
      name: str,
      row: { type: 'integer', description: '0-based row on the floor map' },
      col: { type: 'integer', description: '0-based column on the floor map' },
      note: { type: 'string', description: 'e.g. Indoor, Front row, Senior stylist; empty if none' },
      surcharge_cents: { type: 'integer', description: 'Added to the offering price for this unit (front-row bike, indoor court, senior stylist); 0 if none' },
    }),
  },
  layout: obj({
    kind: { type: 'string', enum: ['grid', 'cards'], description: 'grid = floor map (courts, bikes); cards = people' },
    rows: int,
    cols: int,
    front_label: nullable(str),
  }),
  hours: obj({ open: hhmm, close: hhmm, days: { type: 'array', items: { type: 'integer', description: 'ISO weekday: 1=Monday … 5=Friday, 6=Saturday, 7=Sunday' } } }),
  slot_step_minutes: int,
  offerings: {
    type: 'array',
    items: obj({
      key: str,
      name: str,
      description: str,
      duration_minutes: int,
      price_cents: int,
      peak_price_cents: nullable(int),
      unit_keys: { type: 'array', items: str, description: 'Units that offer this; empty means all' },
    }),
  },
  sessions: {
    type: 'array',
    description: 'Class mode only: fixed weekly start times. Empty for other modes.',
    items: obj({ offering_key: str, days: { type: 'array', items: { type: 'integer', description: 'ISO weekday: 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday. Weekdays = 1,2,3,4,5' } }, start: hhmm }),
  },
  peak: { anyOf: [obj({ start: hhmm, end: hhmm }), { type: 'null' }], description: 'Peak window when peak prices apply, or null' },
  questions: {
    type: 'array',
    description: 'Extra things to ask a customer at checkout, only if the owner mentioned them',
    items: obj({ key: str, label: str, kind: { type: 'string', enum: ['text', 'yesno', 'select'] }, options: { type: 'array', items: str } }),
  },
  policies: obj({ cancellation_hours: int, notes: str }),
});

const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Whatever the model returns, the engine only ever sees a spec that passes this.
export function normalizeSpec(input) {
  const s = structuredClone(input || {});
  const errors = [];
  s.name = String(s.name || 'My business').slice(0, 60);
  s.tagline = String(s.tagline || '').slice(0, 120);
  s.vertical = String(s.vertical || '').slice(0, 40);
  s.emoji = String(s.emoji || '📅').slice(0, 4);
  s.accent = /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : '#4f46e5';
  s.currency = ['eur', 'gbp', 'usd', 'chf'].includes(s.currency) ? s.currency : 'eur';
  s.timezone = validZone(s.timezone) ? s.timezone : 'Europe/Berlin';
  s.mode = ['resource', 'class', 'staff'].includes(s.mode) ? s.mode : 'resource';
  s.unit_label = String(s.unit_label || (s.mode === 'staff' ? 'Staff' : 'Unit')).slice(0, 24);

  const seen = new Set();
  s.units = (Array.isArray(s.units) ? s.units : []).slice(0, 60).map((u, i) => {
    let key = slugify(u.key || u.name) || `unit-${i + 1}`;
    while (seen.has(key)) key += 'x';
    seen.add(key);
    return { key, name: String(u.name || `${s.unit_label} ${i + 1}`).slice(0, 40), row: clamp(u.row, 0, 20, 0), col: clamp(u.col, 0, 20, i), note: String(u.note || '').slice(0, 40), surcharge_cents: clamp(u.surcharge_cents, 0, 100_000, 0) };
  });
  if (!s.units.length) errors.push('No bookable units');
  // Numbered seats ("Bike 7") should read 1, 2, 3… front row first, left to right.
  // Models often number column by column, so keep the floor positions and reassign
  // units to them in number order. A seat's note and surcharge belong to the position.
  const num = (u) => Number(u.name.match(/(\d+)\s*$/)?.[1]);
  if (s.mode === 'class' && s.units.every((u) => Number.isFinite(num(u)))) {
    const spots = [...s.units].sort((a, b) => a.row - b.row || a.col - b.col).map(({ row, col, note, surcharge_cents }) => ({ row, col, note, surcharge_cents }));
    s.units = [...s.units].sort((a, b) => num(a) - num(b)).map((u, i) => ({ ...u, ...spots[i] }));
  }

  const l = s.layout || {};
  s.layout = {
    kind: l.kind === 'cards' || s.mode === 'staff' ? 'cards' : 'grid',
    rows: Math.max(1, ...s.units.map((u) => u.row + 1)),
    cols: Math.max(1, ...s.units.map((u) => u.col + 1)),
    front_label: l.front_label ? String(l.front_label).slice(0, 30) : null,
  };

  const h = s.hours || {};
  s.hours = {
    open: isTime(h.open) ? h.open : '09:00',
    close: isTime(h.close) ? h.close : '21:00',
    days: [...new Set((h.days || [1, 2, 3, 4, 5, 6, 7]).map((d) => clamp(d, 1, 7, 1)))].sort(),
  };
  if (s.hours.close <= s.hours.open) s.hours.close = '23:59';
  s.slot_step_minutes = clamp(s.slot_step_minutes, 5, 240, 30);

  const unitKeys = new Set(s.units.map((u) => u.key));
  const okeys = new Set();
  s.offerings = (Array.isArray(s.offerings) ? s.offerings : []).slice(0, 20).map((o, i) => {
    let key = slugify(o.key || o.name) || `offer-${i + 1}`;
    while (okeys.has(key)) key += 'x';
    okeys.add(key);
    const price = clamp(o.price_cents, 0, 1_000_000, 0);
    return {
      key,
      name: String(o.name || 'Booking').slice(0, 60),
      description: String(o.description || '').slice(0, 200),
      duration_minutes: clamp(o.duration_minutes, 5, 720, 60),
      price_cents: price,
      peak_price_cents: o.peak_price_cents == null ? null : clamp(o.peak_price_cents, 0, 1_000_000, price),
      unit_keys: (o.unit_keys || []).map(slugify).filter((k) => unitKeys.has(k)),
    };
  });
  if (!s.offerings.length) errors.push('No offerings');

  s.sessions = s.mode !== 'class' ? [] : (s.sessions || [])
    .filter((x) => okeys.has(slugify(x.offering_key)) && isTime(x.start))
    .map((x) => ({ offering_key: slugify(x.offering_key), days: [...new Set((x.days || []).map((d) => clamp(d, 1, 7, 1)))], start: x.start }));
  if (s.mode === 'class' && !s.sessions.length) errors.push('Class mode needs at least one session');

  s.peak = s.peak && isTime(s.peak.start) && isTime(s.peak.end) ? { start: s.peak.start, end: s.peak.end } : null;
  s.questions = (s.questions || []).slice(0, 5).map((q, i) => ({
    key: slugify(q.key || q.label) || `q${i}`, label: String(q.label || '').slice(0, 80),
    kind: ['text', 'yesno', 'select'].includes(q.kind) ? q.kind : 'text', options: (q.options || []).map(String).slice(0, 8),
  })).filter((q) => q.label);
  const p = s.policies || {};
  s.policies = { cancellation_hours: clamp(p.cancellation_hours, 0, 168, 24), notes: String(p.notes || '').slice(0, 200) };
  return { spec: s, errors };
}

function validZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return Boolean(tz); } catch { return false; }
}

export { slugify };
