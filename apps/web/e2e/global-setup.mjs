/**
 * Playwright global setup for the local counter E2E.
 *
 * The browser workday cannot start without an active price list: order.receive
 * resolves prices from the catalog and rejects a line that does not match
 * exactly one active item. Nothing else seeds catalog_items, so seed it here
 * before any spec runs. Fastify and Compose stay caller-owned.
 */

import { seedCounterCatalog } from "../../../tools/local/seed-counter-catalog.mjs";

export default async function globalSetup() {
  const count = await seedCounterCatalog(process.env);
  process.stdout.write(`E2E_CATALOG_SEEDED count=${count}\n`);
}
