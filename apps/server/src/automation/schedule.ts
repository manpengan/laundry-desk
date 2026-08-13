import type { AutomationPolicy } from "@laundry/contracts";

type Schedule = AutomationPolicy["schedule"];

type LocalParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}>;

const WEEKDAY: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY[value("weekday")];
  if (weekday === undefined) throw new TypeError("Invalid automation timezone weekday");
  return Object.freeze({
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday,
  });
}

function localTimestamp(parts: LocalParts, hours: number, minutes: number, timeZone: string): Date {
  const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes);
  let candidate = new Date(desiredUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = localParts(candidate, timeZone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate = new Date(candidate.getTime() + desiredUtc - actualUtc);
  }
  return candidate;
}

function shiftedLocalDay(base: LocalParts, days: number, timeZone: string): LocalParts {
  const noon = localTimestamp(base, 12, 0, timeZone);
  return localParts(new Date(noon.getTime() + days * 86_400_000), timeZone);
}

export function nextAutomationRun(schedule: Schedule, timeZone: string, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) throw new TypeError("Invalid automation clock");
  const [hourText = "", minuteText = ""] = schedule.local_time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const base = localParts(after, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = shiftedLocalDay(base, offset, timeZone);
    if (!schedule.days_of_week.includes(day.weekday)) continue;
    const candidate = localTimestamp(day, hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

export function insideAutomationWindow(schedule: Schedule, timeZone: string, now: Date): boolean {
  const local = localParts(now, timeZone);
  if (!schedule.days_of_week.includes(local.weekday)) return false;
  const minute = local.hour * 60 + local.minute;
  const toMinute = (value: string): number => {
    const [hours = "", minutes = ""] = value.split(":");
    return Number(hours) * 60 + Number(minutes);
  };
  return (
    minute >= toMinute(schedule.window_start_local) && minute < toMinute(schedule.window_end_local)
  );
}

export function localBusinessDate(timeZone: string, now: Date): string {
  const local = localParts(now, timeZone);
  return `${local.year.toString().padStart(4, "0")}-${local.month
    .toString()
    .padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
}
