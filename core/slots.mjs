// Turns a spec, a date and the busy list into what a customer can book.
// Pure functions: no database, no network, easy to test.

// Minutes east of UTC for a zone at a given instant.
function zoneOffset(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-10-24" + "18:30" in Europe/Berlin -> Date (UTC instant)
export function zonedTime(day, hm, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
  return new Date(guess.getTime() - zoneOffset(tz, guess) * 60000);
}

const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const toHm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ISO weekday 1=Mon … 7=Sun for a calendar day string
export function isoWeekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

export function priceFor(spec, offering, startHm) {
  if (offering.peak_price_cents != null && spec.peak) {
    const t = toMin(startHm);
    if (t >= toMin(spec.peak.start) && t < toMin(spec.peak.end)) return { cents: offering.peak_price_cents, peak: true };
  }
  return { cents: offering.price_cents, peak: false };
}

// Start times for one offering on one day, in local HH:MM.
export function startTimes(spec, offering, day) {
  const wd = isoWeekday(day);
  if (spec.mode === 'class') {
    return spec.sessions.filter((s) => s.offering_key === offering.key && s.days.includes(wd)).map((s) => s.start).sort();
  }
  if (!spec.hours.days.includes(wd)) return [];
  const out = [];
  const last = toMin(spec.hours.close) - offering.duration_minutes;
  for (let t = toMin(spec.hours.open); t <= last; t += spec.slot_step_minutes) out.push(toHm(t));
  return out;
}

export function unitsFor(spec, offering) {
  return offering.unit_keys.length ? spec.units.filter((u) => offering.unit_keys.includes(u.key)) : spec.units;
}

// busy: [{resource_key, starts_at, ends_at}]
// Returns [{start, starts_at, ends_at, price_cents, peak, free:[unit keys], taken:[unit keys]}]
export function availability(spec, offeringKey, day, busy = [], now = new Date()) {
  const offering = spec.offerings.find((o) => o.key === offeringKey);
  if (!offering) return [];
  const units = unitsFor(spec, offering);
  return startTimes(spec, offering, day).map((start) => {
    const s = zonedTime(day, start, spec.timezone);
    const e = new Date(s.getTime() + offering.duration_minutes * 60000);
    const taken = units.filter((u) => busy.some((b) => b.resource_key === u.key && new Date(b.starts_at) < e && new Date(b.ends_at) > s)).map((u) => u.key);
    const past = s <= now;
    return {
      start, starts_at: s.toISOString(), ends_at: e.toISOString(), past, ...renamePrice(priceFor(spec, offering, start)),
      free: past ? [] : units.map((u) => u.key).filter((k) => !taken.includes(k)),
      taken,
      surcharges: Object.fromEntries(units.filter((u) => u.surcharge_cents).map((u) => [u.key, u.surcharge_cents])),
    };
  });
}

const renamePrice = ({ cents, peak }) => ({ price_cents: cents, peak });
