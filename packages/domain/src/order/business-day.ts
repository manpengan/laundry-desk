export type BusinessDayResult = Readonly<{ business_date: string }>;

type DateParts = Readonly<{ year: string; month: string; day: string; hour: number }>;

const BUSINESS_DAY_SEARCH_RADIUS_MS = 48 * 60 * 60 * 1_000;

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

  const calendar = new Date(`${businessDate}T12:00:00.000Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== businessDate
  ) {
    throw new TypeError("businessDate must be a real YYYY-MM-DD date");
  }

  const requestedWallClockAsUtc = Date.parse(
    `${businessDate}T${String(rolloverHour).padStart(2, "0")}:00:00.000Z`,
  );
  let before = requestedWallClockAsUtc - BUSINESS_DAY_SEARCH_RADIUS_MS;
  let atOrAfter = requestedWallClockAsUtc + BUSINESS_DAY_SEARCH_RADIUS_MS;
  if (businessDayAt(new Date(before), timeZone, rolloverHour).business_date >= businessDate) {
    throw new RangeError("business day start fell outside the supported IANA offset range");
  }
  if (businessDayAt(new Date(atOrAfter), timeZone, rolloverHour).business_date < businessDate) {
    throw new RangeError("business day start fell outside the supported IANA offset range");
  }

  // Resolve by the business-date transition itself, rather than iterating a
  // guessed UTC offset. In a DST gap this chooses the first representable local
  // instant after the skipped cutover; in an overlap it chooses the first of
  // the two occurrences. Both policies preserve a half-open, continuous day.
  while (atOrAfter - before > 1) {
    const midpoint = before + Math.floor((atOrAfter - before) / 2);
    if (businessDayAt(new Date(midpoint), timeZone, rolloverHour).business_date < businessDate) {
      before = midpoint;
    } else {
      atOrAfter = midpoint;
    }
  }
  const resolved = new Date(atOrAfter);
  if (businessDayAt(resolved, timeZone, rolloverHour).business_date !== businessDate) {
    throw new RangeError("businessDate has no representable start in timeZone");
  }
  return resolved;
}
