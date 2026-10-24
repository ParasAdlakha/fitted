// Three demo businesses from the hand-written templates, so the demo never starts empty.
import { randomBytes } from 'node:crypto';
import { TEMPLATES } from './templates.mjs';
import { normalizeSpec, slugify } from './spec.mjs';

const PROMPTS = {
  padel: "We're a padel club in Prenzlauer Berg with 4 courts, 2 indoor (€4 extra) and 2 outdoor. 90 minute matches are €32, €40 after 5pm. Open 8am to 11pm every day. Ask if they want to rent rackets.",
  spin: 'Spin studio in Kreuzberg. 18 bikes in 3 rows facing the instructor. Rhythm Ride 45 min €18, weekdays 7am and Mon–Sat 6:30pm. Hill Climb 60 min €22 Tue, Thu, Sat 10am. Ask shoe size.',
  salon: 'Hair salon in Neukölln, three stylists: Mira (owner, colour), Jonas (cuts and fades), Lea (junior). Cut €45 45 min, skin fade €30 30 min (Jonas or Lea), full colour €110 2h, Mira only. Tue–Sat 10 to 7.',
};

export async function seed(store, { demoAccount = '' } = {}) {
  const out = [];
  for (const [name, raw] of Object.entries(TEMPLATES)) {
    const { spec } = normalizeSpec(raw);
    const slug = slugify(spec.name);
    let biz = await store.getBusiness(slug);
    if (!biz) {
      biz = await store.createBusiness({ slug, owner_key: randomBytes(18).toString('base64url'), name: spec.name, owner_email: null, prompt: PROMPTS[name], spec });
      await store.logAi(biz.id, { kind: 'generate', model: 'template', input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    }
    if (demoAccount && !biz.stripe_account_id) biz = await store.setStripe(biz.id, { stripe_account_id: demoAccount, charges_enabled: true });
    out.push(biz);
  }
  return out;
}
