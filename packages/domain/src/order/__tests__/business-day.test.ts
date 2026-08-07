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

  it("moves a cutover in a DST gap to the first representable local instant", () => {
    const start = businessDayStart("2026-03-08", "America/New_York", 2);
    expect(start.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(businessDayAt(start, "America/New_York", 2)).toEqual({
      business_date: "2026-03-08",
    });
    expect(businessDayAt(new Date(start.getTime() - 1), "America/New_York", 2)).toEqual({
      business_date: "2026-03-07",
    });
  });

  it("uses the first occurrence of an ambiguous cutover during a DST overlap", () => {
    const start = businessDayStart("2026-11-01", "America/New_York", 1);
    expect(start.toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(businessDayAt(start, "America/New_York", 1)).toEqual({
      business_date: "2026-11-01",
    });
    expect(businessDayAt(new Date(start.getTime() - 1), "America/New_York", 1)).toEqual({
      business_date: "2026-10-31",
    });
  });

  it("keeps consecutive business-day boundaries ordered across DST changes", () => {
    const spring = ["2026-03-07", "2026-03-08", "2026-03-09"].map((date) =>
      businessDayStart(date, "America/New_York", 2),
    );
    expect(spring.map((date) => date.toISOString())).toEqual([
      "2026-03-07T07:00:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:00:00.000Z",
    ]);

    const fall = ["2026-10-31", "2026-11-01", "2026-11-02"].map((date) =>
      businessDayStart(date, "America/New_York", 1),
    );
    expect(fall.map((date) => date.toISOString())).toEqual([
      "2026-10-31T05:00:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
    ]);

    for (const [dates, businessDates, rolloverHour] of [
      [spring, ["2026-03-07", "2026-03-08"], 2],
      [fall, ["2026-10-31", "2026-11-01"], 1],
    ] as const) {
      for (let index = 0; index < dates.length - 1; index += 1) {
        const start = dates[index];
        const next = dates[index + 1];
        const businessDate = businessDates[index];
        expect(start).toBeDefined();
        expect(next).toBeDefined();
        expect(businessDate).toBeDefined();
        expect(start!.getTime()).toBeLessThan(next!.getTime());
        expect(
          businessDayAt(new Date(next!.getTime() - 1), "America/New_York", rolloverHour),
        ).toEqual({ business_date: businessDate });
      }
    }
  });

  it("rejects invalid clocks, timezones, and cutovers", () => {
    expect(() => businessDayAt(new Date("invalid"), "Asia/Shanghai")).toThrow(/valid Date/u);
    expect(() => businessDayAt(new Date(), "Not/AZone")).toThrow();
    expect(() => businessDayAt(new Date(), "Asia/Shanghai", 24)).toThrow(/0 to 23/u);
  });
});
