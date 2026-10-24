// Creates the three demo businesses in whichever store is configured and prints owner links.
import { createStore } from '../core/store.mjs';
import { seed } from '../core/seed.mjs';
import { config } from '../core/config.mjs';

const store = createStore();
for (const b of await seed(store, { demoAccount: config.demoAccount })) {
  console.log(`${b.spec.emoji} ${b.name}\n   book:  ${config.baseUrl}/b/${b.slug}\n   owner: ${config.baseUrl}/owner/${b.slug}?key=${b.owner_key}`);
}
console.log(`(store: ${store.kind})`);
