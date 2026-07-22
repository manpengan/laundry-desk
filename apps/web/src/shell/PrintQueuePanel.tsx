/**
 * Small print queue dialog: recent jobs from print.jobs.list.
 */

import { Button, Dialog } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import {
  loadPrintJobs,
  printJobStatusLabel,
  type PrintJobView,
  PRINT_JOBS_LIST_LIMIT,
} from "./print-jobs.js";

export type PrintQueuePanelProps = {
  open: boolean;
  onClose: () => void;
  queryClient: QueryPort;
  /** Injected jobs skip initial fetch (tests / SSR). */
  initialJobs?: readonly PrintJobView[];
};

export function PrintQueuePanel({ open, onClose, queryClient, initialJobs }: PrintQueuePanelProps) {
  const [jobs, setJobs] = useState<readonly PrintJobView[]>(initialJobs ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const next = await loadPrintJobs(queryClient, PRINT_JOBS_LIST_LIMIT);
    setLoading(false);
    if (next === null) {
      setError("无法加载打印队列");
      return;
    }
    setJobs(next);
  }, [queryClient]);

  useEffect(() => {
    if (!open) return;
    if (initialJobs !== undefined) {
      setJobs(initialJobs);
      return;
    }
    void refresh();
  }, [open, initialJobs, refresh]);

  return (
    <Dialog
      open={open}
      title="打印队列"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新"}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="ld-print-queue" data-testid="print-queue-panel">
        {error ? (
          <p className="ld-print-queue__error" role="alert">
            {error}
          </p>
        ) : null}
        {jobs.length === 0 && !loading ? (
          <p className="ld-print-queue__empty" role="status">
            暂无打印任务
          </p>
        ) : (
          <ul className="ld-print-queue__list" aria-label="最近打印任务">
            {jobs.map((job) => (
              <li
                key={job.job_id}
                className="ld-print-queue__row"
                data-status={job.status}
                data-job-id={job.job_id}
              >
                <div className="ld-print-queue__main">
                  <span className="ld-print-queue__ticket">{job.ticket_no}</span>
                  <span className="ld-print-queue__status">{printJobStatusLabel(job.status)}</span>
                </div>
                {job.error ? <p className="ld-print-queue__job-error">{job.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
