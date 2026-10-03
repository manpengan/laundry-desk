import assert from "node:assert/strict";
import test from "node:test";
import { transformV1Snapshot } from "@laundry/migrate-v1/plan";
import { migrationFixture } from "./import-test-fixture.js";
import { migrationPickupCodes, reassignedPickupCount } from "./import-pickup.js";
import { legacyRecords, assertSupportedLegacySettings } from "./import-legacy.js";

test("duplicate v1 pickup codes become unique deterministically while historical codes are preserved", () => {
  const source = migrationFixture();
  const original = source.orders[0]!;
  const snapshot = {
    ...source,
    orders: [original, { ...original, id: 2, orderNo: "20240703-0002" }],
    orderItems: [...source.orderItems, { ...source.orderItems[0]!, id: 12, orderId: 2 }],
  };
  const plan = transformV1Snapshot(snapshot);
  const codes = migrationPickupCodes(plan);
  assert.equal(new Set(codes.values()).size, 2);
  assert.deepEqual([...codes], [...migrationPickupCodes(plan)]);
  assert.equal(reassignedPickupCount(plan), 2);
  const orders = legacyRecords(plan, "00000000-0000-4000-8000-000000000001").filter(
    (record) => record.entity_type === "order",
  );
  assert.ok(orders.every((record) => record.metadata.pickup_code === original.pickupCode));
});
test("oversized historical garment instructions fail before truncating the display contract", () => {
  const source = migrationFixture();
  const plan = transformV1Snapshot({
    ...source,
    orderItems: [{ ...source.orderItems[0]!, itemNotes: "x".repeat(257) }],
  });
  assert.throws(() => assertSupportedLegacySettings(plan), /DISPLAY_MAPPING_REQUIRED/);
});

test("migration custom media type is allowed only for finite upload paths", async () => {
  const { createRequestSecurityPolicy, evaluateLocalRequest } =
    await import("../http/request-security.js");
  const policy = createRequestSecurityPolicy({
    allowedHosts: ["127.0.0.1:8787"],
    browserOrigin: "http://127.0.0.1:5173",
    browserFetchSite: "same-site",
    desktopOrigin: "http://127.0.0.1:8787",
  });
  const headers = {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:5173",
    "sec-fetch-site": "same-site",
    "content-type": "application/vnd.laundry.v1-migration",
  };
  const base = "/api/v2/migrations/v1/drafts";
  assert.equal(evaluateLocalRequest({ method: "POST", url: base, headers }, policy).allowed, true);
  for (const url of [`${base}?outside=1`, `${base}/invalid/photos/invalid`, "/api/v2/commands"])
    assert.equal(evaluateLocalRequest({ method: "POST", url, headers }, policy).allowed, false);
});
