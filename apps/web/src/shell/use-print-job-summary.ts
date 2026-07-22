/**
 * Poll print.jobs.list for TopBar badge when parent does not inject summary.
 */

import { useCallback, useEffect, useState } from "react";
import type { PrintJobSummary } from "@laundry/ui";
import type { QueryPort } from "../commands/types.js";
import { loadPrintJobs, PRINT_JOBS_POLL_MS, summarizePrintJobs } from "./print-jobs.js";

const IDLE: PrintJobSummary = Object.freeze({ queued: 0, failed: 0 });

export function usePrintJobSummary(
  queryClient: QueryPort,
  fixedSummary: PrintJobSummary | undefined,
): PrintJobSummary {
  const [polled, setPolled] = useState<PrintJobSummary>(IDLE);
  const selfManage = fixedSummary === undefined;

  const refresh = useCallback(async () => {
    if (!selfManage) return;
    const jobs = await loadPrintJobs(queryClient);
    if (jobs === null) return;
    setPolled(summarizePrintJobs(jobs));
  }, [queryClient, selfManage]);

  useEffect(() => {
    if (!selfManage) return;
    void refresh();
    const id = setInterval(() => void refresh(), PRINT_JOBS_POLL_MS);
    return () => clearInterval(id);
  }, [selfManage, refresh]);

  return selfManage ? polled : fixedSummary;
}
