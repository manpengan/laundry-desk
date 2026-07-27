import { describe, expect, it } from "vitest";

import { businessDayAt, businessDayStart } from "../business-day.js";

describe("store-local business day", () => {
  it("uses the configured IANA timezone rather than the host timezone", () => {
    const instant = new Date("2026-07-23T16:30:00.000Z");
    expect(businessDayAt(instant, "Asia/Shanghai")).toEqual({ business_date: "2026-07-24" });
    expect(businessDayAt(instant, "America/Los_Angeles")).toEqual({
      business_date: "2026-07-23",
    });
  });

  it("assigns local hours before the configured cutover to the prior calendar day", () => {
    const instant = new Date("2026-07-23T17:30:00.000Z"); // 01:30 Asia/Shanghai next day
    expect(businessDayAt(instant, "Asia/Shanghai", 3)).toEqual({ business_date: "2026-07-23" });
    expect(businessDayAt(instant, "Asia/Shanghai", 1)).toEqual({ business_date: "2026-07-24" });
  });

  it("derives the first instant of a business day in the store timezone", () => {
    expect(businessDayStart("2026-07-24", "Asia/Shanghai", 3).toISOString()).toBe(
      "2026-07-23T19:00:00.000Z",
    );
    expect(
      businessDayAt(businessDayStart("2026-07-24", "Asia/Shanghai", 3), "Asia/Shanghai", 3),
    ).toEqual({
      business_date: "2026-07-24",
    });
  });

  it("rejects invalid clocks, timezones, and cutovers", () => {
    expect(() => businessDayAt(new Date("invalid"), "Asia/Shanghai")).toThrow(/valid Date/u);
    expect(() => businessDayAt(new Date(), "Not/AZone")).toThrow();
    expect(() => businessDayAt(new Date(), "Asia/Shanghai", 24)).toThrow(/0 to 23/u);
  });
});
