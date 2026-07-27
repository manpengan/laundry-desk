export type BusinessDayResult = Readonly<{ business_date: string }>;

type DateParts = Readonly<{ year: string; month: string; day: string; hour: number }>;

function requireValidInstant(instant: Date): void {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError("instant must be a valid Date");
  }
}

function partsAt(instant: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(instant);
  const byType = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new RangeError(`timezone did not provide ${type}`);
    return value;
  };
  return Object.freeze({
    year: byType("year"),
    month: byType("month"),
    day: byType("day"),
    hour: Number(byType("hour")),
  });
}

function priorCalendarDate(year: string, month: string, day: string): string {
  const calendar = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  calendar.setUTCDate(calendar.getUTCDate() - 1);
  return calendar.toISOString().slice(0, 10);
}

/**
 * Derive a store-local business date with an explicit IANA timezone. No host
 * local timezone is consulted; rolloverHour is the store's local day cutover.
 */
export function businessDayAt(
  instant: Date,
  timeZone: string,
  rolloverHour = 0,
): BusinessDayResult {
  requireValidInstant(instant);
  if (timeZone.trim().length === 0) throw new TypeError("timeZone must be a non-empty IANA name");
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    throw new TypeError("rolloverHour must be an integer from 0 to 23");
  }
  const parts = partsAt(instant, timeZone);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return Object.freeze({
    business_date:
      parts.hour >= rolloverHour ? date : priorCalendarDate(parts.year, parts.month, parts.day),
  });
}

/**
 * Resolve the instant at which a named store business day starts. This keeps
 * day-close periods in the store's IANA timezone rather than UTC or host time.
 */
export function businessDayStart(businessDate: string, timeZone: string, rolloverHour = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
    throw new TypeError("businessDate must be YYYY-MM-DD");
  }
  if (timeZone.trim().length === 0) throw new TypeError("timeZone must be a non-empty IANA name");
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    throw new TypeError("rolloverHour must be an integer from 0 to 23");
  }

  const [year, month, day] = businessDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError("businessDate must be YYYY-MM-DD");
  }
  const targetUtc = Date.UTC(year, month - 1, day, rolloverHour);
  let epoch = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(epoch));
    const valueFor = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      if (value === undefined) throw new RangeError(`timezone did not provide ${type}`);
      return Number(value);
    };
    const localAsUtc = Date.UTC(
      valueFor("year"),
      valueFor("month") - 1,
      valueFor("day"),
      valueFor("hour"),
      valueFor("minute"),
      valueFor("second"),
    );
    const next = targetUtc - (localAsUtc - epoch);
    if (next === epoch) return new Date(next);
    epoch = next;
  }
  return new Date(epoch);
}
