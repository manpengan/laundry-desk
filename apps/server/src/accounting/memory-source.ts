import { aggregateAccountingReport } from "@laundry/domain";

import type { AccountingReadPort, MemoryAccountingSourceInput } from "./types.js";

export function createMemoryAccountingSource(
  movements: MemoryAccountingSourceInput = Object.freeze([]),
): AccountingReadPort {
  const snapshot = Object.freeze([...movements]);
  return Object.freeze({
    readReport: async (request) =>
      aggregateAccountingReport(
        snapshot.filter(
          (movement) =>
            movement.business_date >= request.dateFrom &&
            movement.business_date <= request.dateTo &&
            (request.staffId === null || movement.staff_id === request.staffId),
        ),
        request.groupBy,
      ),
  });
}
