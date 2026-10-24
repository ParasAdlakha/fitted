// Every setting in one place. Anything missing switches that part to a local stand-in,
// so the app always runs; the dashboard shows which parts are live.
const env = process.env;

export const config = {
  port: Number(env.PORT || 8790),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 8790}`).replace(/\/$/, ''),

  supabaseUrl: env.SUPABASE_URL || '',
  supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',

  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  connectCountry: env.STRIPE_CONNECT_COUNTRY || 'DE',
  // An already-onboarded test connected account for the seeded demo businesses (optional).
  demoAccount: env.STRIPE_DEMO_ACCOUNT || '',
  platformFeePercent: Number(env.PLATFORM_FEE_PERCENT || 3),

  openaiKey: env.OPENAI_API_KEY || '',
  model: env.AI_MODEL || 'gpt-5-mini',
  // USD per million tokens, used only to show the owner what setup cost.
  priceIn: Number(env.AI_PRICE_IN || 0.25),
  priceOut: Number(env.AI_PRICE_OUT || 2.0),
};

export const live = {
  supabase: Boolean(config.supabaseUrl && config.supabaseServiceKey),
  stripe: Boolean(config.stripeSecretKey),
  ai: Boolean(config.openaiKey),
};
