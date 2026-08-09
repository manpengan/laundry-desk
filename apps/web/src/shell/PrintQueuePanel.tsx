/**
 * Small print queue dialog: recent jobs from print.jobs.list.
 * Failed/uncertain → explicit retry; done → explicit reprint.
 */

import { Button, Dialog, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  loadPrintQueue,
  printJobStatusLabel,
  type PrintJobView,
  type PrintWorkerView,
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
  initialWorker?: PrintWorkerView;
};

type RequeueAction = "retry" | "reprint";

export type PrintQueueActionGate = Readonly<{
  run: (jobId: string, action: () => Promise<void>) => Promise<"completed" | "busy">;
}>;

/** Keep retry/reprint exclusive until the command and its follow-up refresh both settle. */
export function createPrintQueueActionGate(
  onBusyJobIdChange: (jobId: string | null) => void,
): PrintQueueActionGate {
  let busyJobId: string | null = null;
  return Object.freeze({
    async run(jobId, action): Promise<"completed" | "busy"> {
      if (busyJobId !== null) return "busy";
      busyJobId = jobId;
      onBusyJobIdChange(jobId);
      try {
        await action();
        return "completed";
      } finally {
        busyJobId = null;
        onBusyJobIdChange(null);
      }
    },
  });
}

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
  initialWorker,
}: PrintQueuePanelProps) {
  const toast = useToast();
  const [jobs, setJobs] = useState<readonly PrintJobView[]>(initialJobs ?? []);
  const [worker, setWorker] = useState<PrintWorkerView | undefined>(initialWorker);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const actionGate = useMemo(() => createPrintQueueActionGate(setBusyJobId), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadPrintQueue(queryClient, PRINT_JOBS_LIST_LIMIT);
      if (next === null) {
        setError("无法加载打印队列");
        return;
      }
      setJobs(next.jobs);
      setWorker(next.worker);
    } catch {
      setError("无法加载打印队列，请检查本地服务连接");
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (!open) return;
    if (initialJobs !== undefined) {
      setJobs(initialJobs);
      setWorker(initialWorker);
      return;
    }
    void refresh();
  }, [open, initialJobs, initialWorker, refresh]);

  const onRequeue = useCallback(
    async (job: PrintJobView, action: RequeueAction) => {
      await actionGate.run(job.job_id, async () => {
        setError(null);
        try {
          const res = await commandClient.execute<unknown>(commandNameFor(action), {
            job_id: job.job_id,
          });
          if (!res.ok) {
            const message = res.error.message ?? res.error.code;
            setError(message);
            toast.push(message, "error");
            return;
          }
          toast.push(successMessage(action, job.ticket_no), "success");
          await refresh();
        } catch {
          const message = "打印队列命令失败，请检查本地服务连接";
          setError(message);
          toast.push(message, "error");
        }
      });
    },
    [actionGate, commandClient, refresh, toast],
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
        {worker !== undefined ? (
          <div className="ld-print-queue__worker" data-testid="print-worker-status">
            <strong>{worker.state === "running" ? "打印工作器运行中" : "打印工作器已停止"}</strong>
            <span>
              已完成 {worker.processed_jobs} · 失败 {worker.failed_jobs} · 留存{" "}
              {worker.spool_artifacts} 个文件 / {worker.spool_bytes} B
            </span>
            {worker.last_error_code !== null ? (
              <span className="ld-print-queue__job-error">{worker.last_error_code}</span>
            ) : null}
          </div>
        ) : null}
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
                <span className="ld-print-queue__job-id">
                  job_id: <code>{job.job_id}</code>
                </span>
                {job.error ? <p className="ld-print-queue__job-error">{job.error}</p> : null}
                {job.status === "uncertain" ? (
                  <p className="ld-print-queue__job-error" role="alert">
                    可能已经出纸。请先检查纸张，再决定是否手动重试；系统不会自动重复打印。
                  </p>
                ) : null}
                {job.status === "failed" || job.status === "uncertain" || job.status === "done" ? (
                  <div className="ld-print-queue__actions">
                    {job.status !== "done" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        data-action="retry"
                        disabled={loading || busyJobId !== null}
                        onClick={() => void onRequeue(job, "retry")}
                      >
                        {busyJobId === job.job_id
                          ? "重试中…"
                          : job.status === "uncertain"
                            ? "检查纸张后重试"
                            : "重试"}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        data-action="reprint"
                        disabled={loading || busyJobId !== null}
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
