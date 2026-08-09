import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { PrinterPort, PrinterResult, PrinterStatus } from "../host/printer-port.js";

export type PrinterSettingsPanelProps = Readonly<{
  printerPort: PrinterPort;
}>;

function stateLabel(status: PrinterStatus | null): string {
  if (status === null) return "读取中";
  if (status.state === "ready") return "已启用";
  if (status.state === "disabled") return "未启用";
  return "不可用";
}

export function PrinterSettingsPanel({ printerPort }: PrinterSettingsPanelProps) {
  const toast = useToast();
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [selectedQueue, setSelectedQueue] = useState("");
  const [busy, setBusy] = useState(false);

  const acceptStatus = useCallback(
    (result: PrinterResult<PrinterStatus>): boolean => {
      if (!result.ok) {
        toast.push(result.error.message, "error");
        return false;
      }
      setStatus(result.data);
      setSelectedQueue(result.data.configuredQueue ?? result.data.availableQueues[0] ?? "");
      return true;
    },
    [toast],
  );

  const loadStatus = useCallback(async () => {
    setBusy(true);
    try {
      acceptStatus(await printerPort.status());
    } finally {
      setBusy(false);
    }
  }, [acceptStatus, printerPort]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const discover = useCallback(async () => {
    setBusy(true);
    try {
      if (acceptStatus(await printerPort.discover())) toast.push("已刷新 CUPS 队列", "success");
    } finally {
      setBusy(false);
    }
  }, [acceptStatus, printerPort, toast]);

  const configure = useCallback(
    async (queue: string | null) => {
      setBusy(true);
      try {
        const result = await printerPort.configure(queue);
        if (acceptStatus(result)) {
          toast.push(queue === null ? "已停用本机打印" : "打印队列已启用", "success");
        }
      } finally {
        setBusy(false);
      }
    },
    [acceptStatus, printerPort, toast],
  );

  const testFixedTicket = useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("将向已启用队列提交一张固定测试票，可能立即出纸。是否继续？")
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await printerPort.testFixedTicket();
      if (!result.ok) {
        toast.push(result.error.message, "error");
        return;
      }
      toast.push(`测试票已提交 CUPS（${result.data.cupsJobId}），请现场核对出纸`, "success");
    } finally {
      setBusy(false);
    }
  }, [printerPort, toast]);

  const queues = status?.availableQueues ?? [];
  return (
    <section className="ld-printer-settings lg-card" data-testid="printer-settings">
      <div className="ld-printer-settings__heading">
        <div>
          <h2>CUPS 小票打印机</h2>
          <p>仅配置本机已安装队列；签名订单票由主进程领取并回执。</p>
        </div>
        <span
          className={`ld-printer-settings__state is-${status?.state ?? "loading"}`}
          role="status"
        >
          {stateLabel(status)}
        </span>
      </div>

      <label className="ld-printer-settings__label" htmlFor="cups-printer-queue">
        本机 CUPS 队列
      </label>
      <select
        id="cups-printer-queue"
        className="ld-printer-settings__select"
        value={selectedQueue}
        onChange={(event) => setSelectedQueue(event.target.value)}
        disabled={busy || queues.length === 0}
      >
        {queues.length === 0 ? <option value="">未发现可用队列</option> : null}
        {queues.map((queue) => (
          <option key={queue} value={queue}>
            {queue}
          </option>
        ))}
      </select>

      <p className="ld-printer-settings__message">{status?.message ?? "正在读取本机打印状态…"}</p>
      <div className="ld-printer-settings__actions">
        <Button type="button" onClick={() => void discover()} disabled={busy}>
          刷新队列
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => void configure(selectedQueue)}
          disabled={busy || selectedQueue.length === 0}
        >
          启用所选队列
        </Button>
        <Button type="button" onClick={() => void configure(null)} disabled={busy}>
          停用打印
        </Button>
        <Button
          type="button"
          onClick={() => void testFixedTicket()}
          disabled={busy || status?.state !== "ready"}
        >
          打印固定测试票
        </Button>
      </div>
      <p className="ld-printer-settings__evidence">
        CUPS 接单不等于实际出纸。XP-58 中文、金额、条码、走纸、切刀及断线不重复仍须现场验收。
      </p>
    </section>
  );
}
