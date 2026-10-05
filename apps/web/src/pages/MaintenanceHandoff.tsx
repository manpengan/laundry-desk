import { useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { MaintenancePort } from "../host/maintenance-port.js";
export function MaintenanceHandoff({
  port,
  intent,
  requestId,
  expiresAt,
}: Readonly<{
  port?: MaintenancePort;
  intent: "export-store" | "v1-import";
  requestId: string;
  expiresAt: number;
}>) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [expired, setExpired] = useState(expiresAt <= Date.now());
  const generation = useRef(0),
    pending = useRef(false);
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setBusy(false);
    setMessage("");
    setError("");
    const delay = expiresAt - Date.now();
    setExpired(delay <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, Math.min(delay, 2147483647)));
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [port, intent, requestId, expiresAt]);
  const open = async () => {
    if (port === undefined || pending.current) return;
    if (expiresAt <= Date.now()) {
      setExpired(true);
      return;
    }
    const scope = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await port.handoff(intent, requestId);
      if (scope !== generation.current) return;
      if (result.ok)
        setMessage(
          "已打开维护窗口并传递此次授权。请在窗口中选择目录、确认执行并查看进度、结果和校验值。",
        );
      else setError(result.error);
    } catch {
      if (scope === generation.current)
        setError("打开维护程序失败，授权仍需在有效期内使用，可重试。");
    } finally {
      if (scope === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="ld-panel__sub">
      {expired ? (
        <p role="alert">此次授权已过期，请重新核对并生成授权。</p>
      ) : port === undefined ? (
        <p>当前环境不能直接打开本机程序。请在 Windows 桌面版继续，或在维护窗口粘贴上述授权编号。</p>
      ) : (
        <Button disabled={busy} onClick={() => void open()}>
          {busy
            ? "正在打开维护窗口…"
            : intent === "export-store"
              ? "打开维护窗口完成导出"
              : "打开维护窗口完成导入"}
        </Button>
      )}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
