// Three hand-written specs. Used as examples in the AI prompt (few-shot), as the
// offline fallback when no AI key is set, and in tests.

const grid = (prefix, label, rows, cols, note = () => '') => {
  const out = [];
  let n = 1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++, n++) out.push({ key: `${prefix}-${n}`, name: `${label} ${n}`, row: r, col: c, note: note(r, c, n), surcharge_cents: 0 });
  return out;
};

export const TEMPLATES = {
  padel: {
    name: 'Kiez Padel Club', tagline: 'Four courts in Prenzlauer Berg. Book, pay, play.', vertical: 'padel club', emoji: '🎾', accent: '#0f766e',
    currency: 'eur', timezone: 'Europe/Berlin', mode: 'resource', unit_label: 'Court',
    units: [
      { key: 'court-1', name: 'Court 1', row: 0, col: 0, note: 'Indoor', surcharge_cents: 400 },
      { key: 'court-2', name: 'Court 2', row: 0, col: 1, note: 'Indoor', surcharge_cents: 400 },
      { key: 'court-3', name: 'Court 3', row: 1, col: 0, note: 'Outdoor' },
      { key: 'court-4', name: 'Court 4', row: 1, col: 1, note: 'Outdoor' },
    ],
    layout: { kind: 'grid', rows: 2, cols: 2, front_label: null },
    hours: { open: '08:00', close: '23:00', days: [1, 2, 3, 4, 5, 6, 7] }, slot_step_minutes: 30,
    offerings: [
      { key: 'match-90', name: '90 min match', description: 'Court for four players', duration_minutes: 90, price_cents: 3200, peak_price_cents: 4000, unit_keys: [] },
      { key: 'practice-60', name: '60 min practice', description: 'Drills or a quick game', duration_minutes: 60, price_cents: 2400, peak_price_cents: 3000, unit_keys: [] },
    ],
    sessions: [], peak: { start: '17:00', end: '22:00' },
    questions: [{ key: 'rackets', label: 'Rent rackets (€3 each, pay at desk)?', kind: 'yesno', options: [] }],
    policies: { cancellation_hours: 24, notes: 'Free cancellation up to 24 hours before.' },
  },
  spin: {
    name: 'Cadence Ride', tagline: 'Pick your bike. Ride to the beat.', vertical: 'spin studio', emoji: '🚴', accent: '#be123c',
    currency: 'eur', timezone: 'Europe/Berlin', mode: 'class', unit_label: 'Bike',
    units: grid('bike', 'Bike', 3, 6, (r) => (r === 0 ? 'Front row' : '')),
    layout: { kind: 'grid', rows: 3, cols: 6, front_label: 'Instructor' },
    hours: { open: '07:00', close: '21:00', days: [1, 2, 3, 4, 5, 6] }, slot_step_minutes: 15,
    offerings: [
      { key: 'rhythm-45', name: 'Rhythm Ride', description: '45 minutes, full-body, music-led', duration_minutes: 45, price_cents: 1800, peak_price_cents: null, unit_keys: [] },
      { key: 'climb-60', name: 'Hill Climb', description: '60 minutes of endurance intervals', duration_minutes: 60, price_cents: 2200, peak_price_cents: null, unit_keys: [] },
    ],
    sessions: [
      { offering_key: 'rhythm-45', days: [1, 2, 3, 4, 5], start: '07:00' },
      { offering_key: 'rhythm-45', days: [1, 2, 3, 4, 5, 6], start: '18:30' },
      { offering_key: 'climb-60', days: [2, 4, 6], start: '10:00' },
    ],
    peak: null,
    questions: [{ key: 'shoe', label: 'Shoe size for clip-in shoes', kind: 'select', options: ['Own shoes', '38', '39', '40', '41', '42', '43', '44', '45'] }],
    policies: { cancellation_hours: 12, notes: 'Cancel up to 12 hours before class for a full refund.' },
  },
  salon: {
    name: 'Studio Mira', tagline: 'Cuts and colour in Neukölln.', vertical: 'hair salon', emoji: '💇', accent: '#7c3aed',
    currency: 'eur', timezone: 'Europe/Berlin', mode: 'staff', unit_label: 'Stylist',
    units: [
      { key: 'mira', name: 'Mira', row: 0, col: 0, note: 'Owner, colour specialist' },
      { key: 'jonas', name: 'Jonas', row: 0, col: 1, note: 'Cuts and fades' },
      { key: 'lea', name: 'Lea', row: 0, col: 2, note: 'Junior stylist' },
    ],
    layout: { kind: 'cards', rows: 1, cols: 3, front_label: null },
    hours: { open: '10:00', close: '19:00', days: [2, 3, 4, 5, 6] }, slot_step_minutes: 15,
    offerings: [
      { key: 'cut', name: 'Cut and style', description: 'Wash, cut, blow-dry', duration_minutes: 45, price_cents: 4500, peak_price_cents: null, unit_keys: [] },
      { key: 'fade', name: 'Skin fade', description: 'Clippers and finish', duration_minutes: 30, price_cents: 3000, peak_price_cents: null, unit_keys: ['jonas', 'lea'] },
      { key: 'colour', name: 'Full colour', description: 'Consultation and colour', duration_minutes: 120, price_cents: 11000, peak_price_cents: null, unit_keys: ['mira'] },
    ],
    sessions: [], peak: null,
    questions: [{ key: 'notes', label: 'Anything we should know?', kind: 'text', options: [] }],
    policies: { cancellation_hours: 24, notes: 'Late cancellations are charged 50%.' },
  },
};

// Offline stand-in for the model: pick the closest template by keyword.
export function pickTemplate(prompt) {
  const p = String(prompt).toLowerCase();
  if (/spin|cycl|bike|ride|yoga|pilates|class|studio|workout|gym/.test(p)) return structuredClone(TEMPLATES.spin);
  if (/salon|hair|barber|stylist|nail|beauty|massage|therap|tutor|appointment/.test(p)) return structuredClone(TEMPLATES.salon);
  return structuredClone(TEMPLATES.padel);
}
