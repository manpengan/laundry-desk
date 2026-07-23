/**
 * Small print queue dialog: recent jobs from print.jobs.list.
 * Failed → 重试 (print.ticket.retry); done → 补打 (print.ticket.reprint).
 */

import { Button, Dialog, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
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
  /** Used for retry / reprint commands. */
  commandClient: CommandPort;
  /** Injected jobs skip initial fetch (tests / SSR). */
  initialJobs?: readonly PrintJobView[];
};

type RequeueAction = "retry" | "reprint";

function commandNameFor(action: RequeueAction): string {
  return action === "retry" ? "print.ticket.retry" : "print.ticket.reprint";
}

function successMessage(action: RequeueAction, ticketNo: string): string {
  return action === "retry" ? `已重试 ${ticketNo}` : `已补打 ${ticketNo}`;
}

export function PrintQueuePanel({
  open,
  onClose,
  queryClient,
  commandClient,
  initialJobs,
}: PrintQueuePanelProps) {
  const toast = useToast();
  const [jobs, setJobs] = useState<readonly PrintJobView[]>(initialJobs ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

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

  const onRequeue = useCallback(
    async (job: PrintJobView, action: RequeueAction) => {
      setBusyJobId(job.job_id);
      setError(null);
      const res = await commandClient.execute<unknown>(commandNameFor(action), {
        job_id: job.job_id,
      });
      setBusyJobId(null);
      if (!res.ok) {
        const message = res.error.message ?? res.error.code;
        setError(message);
        toast.push(message, "error");
        return;
      }
      toast.push(successMessage(action, job.ticket_no), "success");
      await refresh();
    },
    [commandClient, refresh, toast],
  );

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
            disabled={loading || busyJobId !== null}
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
                {job.status === "failed" || job.status === "done" ? (
                  <div className="ld-print-queue__actions">
                    {job.status === "failed" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        data-action="retry"
                        disabled={busyJobId !== null}
                        onClick={() => void onRequeue(job, "retry")}
                      >
                        {busyJobId === job.job_id ? "重试中…" : "重试"}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        data-action="reprint"
                        disabled={busyJobId !== null}
                        onClick={() => void onRequeue(job, "reprint")}
                      >
                        {busyJobId === job.job_id ? "补打中…" : "补打"}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
