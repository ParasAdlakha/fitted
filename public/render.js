// Shared by every page: turns a spec into UI. No framework; the spec is the template.

export const $ = (sel, el = document) => el.querySelector(sel);
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

export const money = (cents, cur = 'eur') => new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MODE_LABEL = { resource: 'Book a unit by time', class: 'Pick a seat in a class', staff: 'Book a person' };

export function applyTheme(spec) {
  document.documentElement.style.setProperty('--accent', spec.accent);
}

// Floor map: courts as courts, bikes as seats facing the instructor, staff as cards.
export function floor(spec, { offering, free = null, taken = [], selected = null, onPick = null } = {}) {
  const allowed = offering?.unit_keys?.length ? new Set(offering.unit_keys) : null;
  const style = spec.layout.kind === 'cards' ? 'cards' : spec.mode === 'class' ? 'seat' : spec.mode === 'resource' ? 'court' : '';
  const el = h('div', { class: `floor ${style}`, style: { '--cols': spec.layout.cols } });
  if (spec.layout.front_label && style !== 'cards') el.append(h('div', { class: 'front' }, spec.layout.front_label));
  const units = [...spec.units].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const u of units) {
    const off = allowed && !allowed.has(u.key);
    const isTaken = off || taken.includes(u.key) || (free && !free.includes(u.key));
    const isFree = free && !isTaken;
    const btn = h('button', {
      type: 'button', class: `unit ${isFree ? 'free' : ''} ${isTaken && free ? 'taken' : ''} ${selected === u.key ? 'selected' : ''}`,
      disabled: (isTaken && free) || off || !onPick, 'aria-pressed': selected === u.key ? 'true' : 'false',
      'aria-label': `${u.name}${u.note ? `, ${u.note}` : ''}${isTaken && free ? ', taken' : ''}`,
      style: style === 'cards' ? null : { gridRow: u.row + (spec.layout.front_label ? 2 : 1), gridColumn: u.col + 1 },
      onclick: () => onPick?.(u.key),
    });
    if (style === 'cards') btn.append(h('span', { class: 'avatar' }, u.name.slice(0, 1)), h('span', { style: { minWidth: 0, display: 'flex', flexDirection: 'column' } }, h('b', {}, u.name), h('small', {}, [u.note || spec.unit_label, u.surcharge_cents ? `+${money(u.surcharge_cents, spec.currency)}` : ''].filter(Boolean).join(' · '))));
    else if (style === 'seat') btn.append(h('b', {}, u.name.replace(/^\D+/, '') || u.name), h('small', {}, u.surcharge_cents ? `+${money(u.surcharge_cents, spec.currency)}` : u.note));
    else btn.append(h('b', {}, u.name), h('small', {}, [u.note, u.surcharge_cents ? `+${money(u.surcharge_cents, spec.currency)}` : ''].filter(Boolean).join(' · ')));
    el.append(btn);
  }
  return el;
}

// What the AI understood, in plain words, so the owner can check it at a glance.
export function summary(spec) {
  const hours = spec.mode === 'class'
    ? spec.sessions.map((s) => `${spec.offerings.find((o) => o.key === s.offering_key)?.name} ${s.start} ${s.days.map((d) => DAYS[d - 1]).join(' ')}`)
    : [`${spec.hours.open}–${spec.hours.close}, ${spec.hours.days.length === 7 ? 'every day' : spec.hours.days.map((d) => DAYS[d - 1]).join(' ')}`];
  return h('dl', { class: 'facts' },
    fact('Booking type', MODE_LABEL[spec.mode]),
    fact(`${spec.unit_label}s`, `${spec.units.length}: ${spec.units.slice(0, 6).map((u) => u.name).join(', ')}${spec.units.length > 6 ? '…' : ''}`),
    extras(spec),
    fact('Offerings', spec.offerings.map((o) => `${o.name} · ${o.duration_minutes} min · ${money(o.price_cents, spec.currency)}${o.peak_price_cents != null ? ` (${money(o.peak_price_cents, spec.currency)} peak)` : ''}`).join('\n')),
    fact(spec.mode === 'class' ? 'Schedule' : 'Hours', hours.join('\n')),
    spec.peak && fact('Peak', `${spec.peak.start}–${spec.peak.end}`),
    spec.questions.length > 0 && fact('Asks customers', spec.questions.map((q) => q.label).join('\n')),
    fact('Policy', spec.policies.notes || `Free cancellation up to ${spec.policies.cancellation_hours}h before.`),
  );
}
const fact = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
function extras(spec) {
  const paid = spec.units.filter((u) => u.surcharge_cents);
  if (!paid.length) return null;
  // Group "+€4" units so 6 front-row bikes read as one line
  const groups = {};
  for (const u of paid) (groups[u.surcharge_cents] ||= []).push(u.name);
  return fact('Extras', Object.entries(groups).map(([c, names]) => `+${money(+c, spec.currency)}: ${names.join(', ')}`).join('\n'));
}

export function toast(msg, ms = 3200) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export async function api(path, { method = 'GET', body, key } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-owner-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Owner keys live only in the owner's browser.
export const ownerKey = {
  get: (slug) => { try { return JSON.parse(localStorage.getItem('fitted.keys') || '{}')[slug] || null; } catch { return null; } },
  set: (slug, key) => { try { const m = JSON.parse(localStorage.getItem('fitted.keys') || '{}'); m[slug] = key; localStorage.setItem('fitted.keys', JSON.stringify(m)); } catch {} },
};

export async function statusChips(el) {
  try {
    const s = await api('/api/status');
    el.replaceChildren(
      h('span', { class: `chip ${s.live.supabase ? 'on' : 'off'}`, title: s.live.supabase ? 'Data in Supabase Postgres' : 'SUPABASE_URL not set: in-memory store' }, h('i', { class: 'd' }), s.live.supabase ? 'Supabase' : 'Local DB'),
      h('span', { class: `chip ${s.live.stripe ? 'on' : 'off'}`, title: s.live.stripe ? 'Stripe Connect, test mode' : 'STRIPE_SECRET_KEY not set: local checkout' }, h('i', { class: 'd' }), s.live.stripe ? 'Stripe Connect' : 'Local pay'),
      h('span', { class: `chip ${s.live.ai ? 'on' : 'off'}`, title: s.model }, h('i', { class: 'd' }), s.live.ai ? s.model : 'Offline AI'),
    );
  } catch {}
}
