// The only place a model is called. Two jobs, both at setup time, never per booking:
//   generate  owner's description -> spec
//   refine    spec + one instruction ("add a fifth court") -> new spec
// Output is forced into SPEC_SCHEMA, then normalizeSpec checks it again.
import { config, live } from './config.mjs';
import { SPEC_SCHEMA, normalizeSpec } from './spec.mjs';
import { TEMPLATES, pickTemplate } from './templates.mjs';

const SYSTEM = `You configure booking software for small businesses.
The owner describes their business in their own words. Return a spec the booking engine can run.

Choose mode:
- resource: customers book a unit for a length of time (courts, rooms, boats, studios)
- class: customers take a seat in a scheduled session (bikes in spin, mats in yoga); add sessions
- staff: customers book a person for a service (stylists, therapists, tutors); layout.kind = cards

Rules:
- Use the owner's numbers exactly: unit counts, prices, durations, hours, days. Prices in cents.
- If something is not said, choose a sensible default for that kind of business and keep it simple.
- units: lay them out like the real floor. Courts in a grid, bikes in rows facing the instructor (front_label), staff in one row.
- unit keys short and lowercase (court-1, bike-7, anna). Offering keys likewise.
- Number units in reading order: row 0 is the front, left to right, then the next row (bike-1 … bike-6 in row 0, bike-7 … in row 1).
- surcharge_cents on a unit when some units cost more (front-row bikes, indoor courts, senior stylists); otherwise 0.
- peak and peak_price_cents only if the owner mentions peak or evening pricing; otherwise null.
- questions only for things the owner asked to collect. Never ask for card or payment details; Stripe handles payment.
- Pick an accent colour that suits the business and reads well on white.
- Days are ISO weekdays: 1=Monday … 7=Sunday. "Weekdays" = [1,2,3,4,5]. "Mon–Sat" = [1,2,3,4,5,6].
- Default currency eur and timezone Europe/Berlin unless the owner says otherwise.`;

const example = { owner: 'We are a padel club in Prenzlauer Berg with 4 courts, 2 indoor 2 outdoor. 90 minute matches €32, €40 in the evening from 5pm. Open 8 to 11 every day. Ask if they want to rent rackets.', spec: TEMPLATES.padel };

export async function generateSpec(prompt) {
  if (!live.ai) return offline(pickTemplate(prompt), 'generate');
  return call('generate', [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: example.owner },
    { role: 'assistant', content: JSON.stringify(example.spec) },
    { role: 'user', content: prompt },
  ]);
}

export async function refineSpec(spec, instruction) {
  if (!live.ai) return offline(spec, 'refine');
  return call('refine', [
    { role: 'system', content: `${SYSTEM}\n\nYou are editing an existing spec. Apply only the owner's change and keep everything else identical, including keys of units and offerings that still exist.` },
    { role: 'user', content: `Current spec:\n${JSON.stringify(spec)}\n\nChange: ${instruction}` },
  ]);
}

async function call(kind, messages) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      reasoning_effort: 'minimal',
      response_format: { type: 'json_schema', json_schema: { name: 'business_spec', strict: true, schema: SPEC_SCHEMA } },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`AI error ${res.status}: ${body.error?.message || 'unknown'}`);
  const raw = JSON.parse(body.choices[0].message.content);
  const { spec, errors } = normalizeSpec(raw);
  const input = body.usage?.prompt_tokens || 0;
  const output = body.usage?.completion_tokens || 0;
  return {
    spec, errors,
    usage: { kind, model: config.model, input_tokens: input, output_tokens: output, cost_usd: (input * config.priceIn + output * config.priceOut) / 1e6, ms: Date.now() - t0 },
  };
}

function offline(raw, kind) {
  const { spec, errors } = normalizeSpec(raw);
  return { spec, errors, usage: { kind, model: 'offline-template', input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0 } };
}
