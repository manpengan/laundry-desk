import { describe, expect, it } from "vitest";

import { OrderHoldInputSchema, OrderReceiveInputSchema } from "../src/commands/order.js";

const detailedLine = Object.freeze({
  service_code: "dry",
  category_code: "coat",
  qty: 2,
  garments: Object.freeze([
    Object.freeze({
      color: "黑",
      brand: "示例牌",
      defects: Object.freeze(["左袖破损"]),
      accessories: Object.freeze(["腰带"]),
      note: "保持衣架",
      addon_codes: Object.freeze(["stain"]),
    }),
    Object.freeze({ color: "灰" }),
  ]),
});

describe("order piece details", () => {
  it("accepts one bounded detail per physical piece for receive and hold", () => {
    expect(OrderReceiveInputSchema.safeParse({ lines: [detailedLine] }).success).toBe(true);
    expect(OrderHoldInputSchema.safeParse({ lines: [detailedLine] }).success).toBe(true);
  });

  it("rejects count mismatches, duplicate add-ons, and oversized fields", () => {
    expect(
      OrderReceiveInputSchema.safeParse({
        lines: [{ ...detailedLine, garments: detailedLine.garments.slice(0, 1) }],
      }).success,
    ).toBe(false);
    expect(
      OrderReceiveInputSchema.safeParse({
        lines: [
          {
            ...detailedLine,
            garments: [{ ...detailedLine.garments[0], addon_codes: ["stain", "stain"] }, {}],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OrderReceiveInputSchema.safeParse({
        lines: [
          {
            ...detailedLine,
            garments: [{ ...detailedLine.garments[0], note: "x".repeat(257) }, {}],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
