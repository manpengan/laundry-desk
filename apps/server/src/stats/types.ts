/**
 * M2 stats query port (day summary). Implementations derive from OrderStore
 * or a process-local seed map for unit tests.
 */

import type { DaySummary } from "@laundry/domain";

export type DaySummaryResult = DaySummary;

export type StatsDaySummaryInput = Readonly<{
  orgId: string;
  storeId: string;
  businessDate: string;
}>;

export type StatsCashSummary = Readonly<{
  /** Net cash movement for the store business day, including reversals/refunds. */
  cash_cents: number;
}>;

/** ADR-91 P1-5: the 账目 report's two bases for one business day, computed by the same code. */
export type StatsIncomeSummary = Readonly<{
  /** Money actually received, net of refunds and reversals, including stored-value top-ups. */
  real_income_cents: number;
  /** Order settlements of the day in any tender, including member balance. */
  performance_income_cents: number;
}>;

/** Read port used by stats.day.summary handler. */
export type StatsQueryPort = Readonly<{
  daySummary: (input: StatsDaySummaryInput) => Promise<DaySummaryResult>;
  cashSummary: (input: StatsDaySummaryInput) => Promise<StatsCashSummary>;
  /** Absent in isolated sources without an accounting ledger. */
  incomeSummary?: (
    input: StatsDaySummaryInput & Readonly<{ staffId: string }>,
  ) => Promise<StatsIncomeSummary>;
}>;
