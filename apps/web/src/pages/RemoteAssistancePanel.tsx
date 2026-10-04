import { useEffect, useRef, useState } from "react";
import type { RemoteAssistanceStatus } from "@laundry/contracts";
import type { RemoteAssistancePort } from "../host/remote-assistance-port.js";

const states: Record<RemoteAssistanceStatus["state"], string> = {
  unconfigured: "尚未配置支持端",
  idle: "未开启",
  active: "协助已开启",
  revoked: "已撤销",
  expired: "已到期",
  interrupted: "已中断，请重新授权",
};
export function RemoteAssistancePanel({
  port,
  sessionKey,
}: Readonly<{ port: RemoteAssistancePort; sessionKey: string }>) {
  const [status, setStatus] = useState<RemoteAssistanceStatus | null>(null);
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setPassword("");
    setConsent(false);
    setError("");
    setBusy(false);
    const refresh = async () => {
      const result = await port.status();
      if (current !== generation.current) return;
      if (result.ok) {
        setStatus(result.data);
        setError("");
      } else setError(result.error);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [port, sessionKey]);
  const authorize = async () => {
    if (!password || !consent || busy || !status?.configured) return;
    const current = generation.current,
      secret = password;
    setPassword("");
    setBusy(true);
    setError("");
    const result = await port.authorize({ password: secret, consent: true });
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) {
      setStatus(result.data);
      setConsent(false);
    } else setError(result.error);
  };
  const revoke = async () => {
    if (!status?.session_id) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    const result = await port.revoke(status.session_id);
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) setStatus(result.data);
    else setError(result.error);
  };
  return (
    <div className="space-y-4">
      <p>
        支持人员仅能查看服务健康、程序版本及维护次数。每条命令须通过支持人员签名和多因素认证校验，操作留有审计记录。
      </p>
      <p>
        协助从本机主动连接支持端，不开放远程入站端口；不会提供顾客资料、照片、密钥、数据库或命令行访问。
      </p>
      {status && (
        <p role="status">
          状态：{states[status.state]}。已完成 {status.commands_completed} 条诊断命令。
        </p>
      )}
      {status?.state === "unconfigured" && (
        <p>请先由本机维护工具配置受信支持端及身份验证公钥。配置完成并重启服务后才能开启。</p>
      )}
      {status?.state === "active" ? (
        <div className="space-y-2">
          <p>
            协助编号：<code className="select-all break-all">{status.session_id}</code>
          </p>
          <p>
            到期时间：{status.expires_at ? new Date(status.expires_at).toLocaleString() : "—"}
            。关闭服务会立即中断，重启后需要重新授权。
          </p>
          <button type="button" onClick={() => void revoke()} className="rounded border px-3 py-2">
            立即撤销协助
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              disabled={!status?.configured || busy}
            />
            我同意向已配置的支持端提供上述只读诊断，授权最长一小时，可随时撤销。
          </label>
          <label className="block">
            当前管理员密码
            <input
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!status?.configured || busy}
              className="ml-2 rounded border p-2"
            />
          </label>
          <button
            type="button"
            disabled={!status?.configured || !consent || !password || busy}
            onClick={() => void authorize()}
            className="rounded border px-3 py-2"
          >
            开启一小时协助
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
