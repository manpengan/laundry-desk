import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { OfflinePort, OfflineStatusView } from "../host/offline-port.js";

export type OfflineConflictPanelProps = Readonly<{ offlinePort: OfflinePort }>;

export function OfflineConflictPanel({ offlinePort }: OfflineConflictPanelProps) {
  const toast = useToast();
  const [status, setStatus] = useState<OfflineStatusView | null>(null);
  const [busyQueueId, setBusyQueueId] = useState<string | null>(null);
  const [discardReason, setDiscardReason] = useState("");

  const refresh = useCallback(async () => {
    const result = await offlinePort.status();
    if (result.ok) setStatus(result.data);
  }, [offlinePort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = useCallback(
    async (queueId: string, action: "retry" | "discard") => {
      const reason = discardReason.trim();
      if (action === "discard" && reason.length < 3) {
        toast.push("放弃前请填写至少 3 个字符的原因", "error");
        return;
      }
      setBusyQueueId(queueId);
      try {
        const result = await offlinePort.resolve(queueId, action, reason);
        if (!result.ok) {
          toast.push(result.error.message, "error");
          return;
        }
        setStatus(result.data);
        if (action === "discard") setDiscardReason("");
        toast.push(action === "retry" ? "已重新尝试同步" : "已放弃该离线操作", "success");
      } finally {
        setBusyQueueId(null);
      }
    },
    [discardReason, offlinePort, toast],
  );

  if (status === null) return null;

  return (
    <section className="ld-settings-offline" aria-label="离线同步">
      <h2>离线同步</h2>
      <p role="status">
        待同步 {status.pendingCount} 项，重放中 {status.inflightCount} 项，冲突{" "}
        {status.conflicts.length} 项。
      </p>
      {status.conflicts.length === 0 ? (
        <p>当前没有需要人工处理的离线冲突。</p>
      ) : (
        <>
          <Input
            name="offline-discard-reason"
            label="放弃原因"
            value={discardReason}
            maxLength={256}
            onChange={(event) => setDiscardReason(event.target.value)}
            hint="放弃会先由在线命令总线验证并写入审计，再从本机队列移除。"
          />
          <ul>
            {status.conflicts.map((conflict) => (
              <li key={conflict.queueId}>
                <code>{conflict.command}</code>：{conflict.errorCode}
                <div className="ld-settings-form__actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyQueueId === conflict.queueId}
                    onClick={() => void resolve(conflict.queueId, "retry")}
                  >
                    重试
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busyQueueId === conflict.queueId || discardReason.trim().length < 3}
                    onClick={() => void resolve(conflict.queueId, "discard")}
                  >
                    审计后放弃
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
