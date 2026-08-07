const DAY_MILLISECONDS = 86_400_000;

export const OWNER_DASHBOARD_TREND_DAYS = 30;
export const OWNER_DASHBOARD_OVERDUE_DAYS = 30;

export function shiftBusinessDate(businessDate: string, days: number): string {
  if (!Number.isInteger(days)) throw new TypeError("days must be an integer");
  const date = new Date(`${businessDate}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== businessDate) {
    throw new TypeError("businessDate must be a real YYYY-MM-DD date");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function ownerDashboardOverdueCutoff(now: Date): Date {
  return new Date(now.getTime() - OWNER_DASHBOARD_OVERDUE_DAYS * DAY_MILLISECONDS);
}
