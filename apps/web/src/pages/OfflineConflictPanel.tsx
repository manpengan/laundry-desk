import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { OfflinePort, OfflineStatusView } from "../host/offline-port.js";

export type OfflineConflictPanelProps = Readonly<{ offlinePort: OfflinePort }>;

export function OfflineConflictPanel({ offlinePort }: OfflineConflictPanelProps) {
  const toast = useToast();
  const [status, setStatus] = useState<OfflineStatusView | null>(null);
  const [busyQueueId, setBusyQueueId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await offlinePort.status();
    if (result.ok) setStatus(result.data);
  }, [offlinePort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = useCallback(
    async (queueId: string, action: "retry" | "discard") => {
      setBusyQueueId(queueId);
      try {
        const result = await offlinePort.resolve(queueId, action);
        if (!result.ok) {
          toast.push(result.error.message, "error");
          return;
        }
        setStatus(result.data);
        toast.push(action === "retry" ? "已重新尝试同步" : "已放弃该离线操作", "success");
      } finally {
        setBusyQueueId(null);
      }
    },
    [offlinePort, toast],
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
                  disabled={busyQueueId === conflict.queueId}
                  onClick={() => void resolve(conflict.queueId, "discard")}
                >
                  放弃
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
