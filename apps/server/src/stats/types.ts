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

/** Read port used by stats.day.summary handler. */
export type StatsQueryPort = Readonly<{
  daySummary: (input: StatsDaySummaryInput) => Promise<DaySummaryResult>;
}>;
