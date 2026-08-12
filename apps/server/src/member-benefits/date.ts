const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function dateAtUtcMidnight(value: string): Date {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) throw new TypeError(`Invalid business date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError(`Invalid business date: ${value}`);
  }
  return date;
}

export function addCalendarDays(value: string, days: number): string {
  if (!Number.isInteger(days) || days < 1) throw new TypeError("days must be a positive integer");
  const date = dateAtUtcMidnight(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const isExpiredOn = (expiresOn: string, businessDate: string): boolean =>
  expiresOn < businessDate;
