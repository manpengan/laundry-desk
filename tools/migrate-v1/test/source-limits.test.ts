import { readFile, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { it, expect } from "vitest";
import { createFixtureDatabase } from "./helpers.js";
import { extractV1Snapshot } from "../src/extract-v1.js";
import { transformV1Snapshot } from "../src/transform.js";

it("rejects compact SQLite containing huge zero-price quantities before garment expansion", async () => {
  const f = await createFixtureDatabase();
  try {
    const db = new Database(f.path);
    db.exec(
      "UPDATE order_items SET quantity=9000000000000,unit_price=0,subtotal=0 WHERE id=11; UPDATE orders SET total_amount=0,paid_amount=0 WHERE id=1",
    );
    db.close();
    expect((await readFile(f.path)).length).toBeLessThan(100000);
    const source = await extractV1Snapshot(f.path);
    expect(() => transformV1Snapshot(source)).toThrow();
    const many = {
      ...source,
      orderItems: source.orderItems.map((row) => ({
        ...row,
        quantity: 60000,
        unitPriceCents: 0,
        subtotalCents: 0,
      })),
    };
    expect(() => transformV1Snapshot(many)).toThrow(/GARMENT_LIMIT/u);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
