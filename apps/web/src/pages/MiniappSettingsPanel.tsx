import { useEffect, useRef, useState } from "react";
import type { MiniappSettingsView } from "@laundry/contracts";
import type { MiniappSettingsPort } from "../host/miniapp-settings-port.js";
export function MiniappSettingsPanel({
  port,
  sessionKey,
}: {
  port: MiniappSettingsPort;
  sessionKey: string;
}) {
  const [view, setView] = useState<MiniappSettingsView | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [appId, setAppId] = useState(""),
    [secret, setSecret] = useState(""),
    [password, setPassword] = useState(""),
    [staff, setStaff] = useState(""),
    [templates, setTemplates] = useState("");
  const [enabled, setEnabled] = useState(false),
    [transactions, setTransactions] = useState(false);
  const generation = useRef(0);
  const load = (value: MiniappSettingsView) => {
    setView(value);
    setAppId(value.app_id ?? "");
    setEnabled(value.enabled);
    setTransactions(value.transactions_enabled);
    setStaff(value.delegated_staff_id ?? "");
    setTemplates(value.subscription_template_ids.join("\n"));
  };
  useEffect(() => {
    const current = ++generation.current;
    setView(null);
    setSecret("");
    setPassword("");
    setMessage("");
    setBusy(true);
    void port
      .read()
      .then((result) => {
        if (current !== generation.current) return;
        if (result.ok) load(result.data);
        else setMessage(result.error);
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [port, sessionKey]);
  const save = async () => {
    if (view === null || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const result = await port.save({
      expected_version: view.version,
      password,
      enabled,
      transactions_enabled: transactions,
      delegated_staff_id: staff.trim() || null,
      app_id: appId.trim(),
      ...(secret === "" ? {} : { app_secret: secret }),
      subscription_template_ids: templates.split(/\s+/u).filter(Boolean),
    });
    if (current !== generation.current) return;
    setBusy(false);
    setPassword("");
    setSecret("");
    if (result.ok) {
      load(result.data);
      setMessage("配置已保存，原有顾客会话已失效。");
    } else setMessage(result.error);
  };
  return (
    <section aria-label="顾客小程序配置">
      <h3>顾客小程序</h3>
      <p>
        启用前请配置微信 AppID 与
        AppSecret。交易由指定员工的当前权限约束；顾客确认后提交，支付以服务端到账为准。
      </p>
      {view?.custody_available === false && (
        <p role="status">本机安全密钥托管不可用，小程序保持关闭。</p>
      )}
      <fieldset disabled={busy || view === null || !view.custody_available}>
        <label>
          微信 AppID
          <input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" />
        </label>
        <label>
          AppSecret（留空保留原值）
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              if (!e.target.checked) setTransactions(false);
            }}
          />
          启用顾客登录与查询
        </label>
        <label>
          委托员工
          <select value={staff} onChange={(e) => setStaff(e.target.value)}>
            <option value="">未委托</option>
            {view?.eligible_staff.map((person) => (
              <option key={person.staff_id} value={person.staff_id}>
                {person.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={transactions}
            disabled={!enabled}
            onChange={(e) => setTransactions(e.target.checked)}
          />
          允许顾客预约、支付与本人权益操作
        </label>
        <label>
          订阅模板 ID（最多三个，逐行输入）
          <textarea value={templates} onChange={(e) => setTemplates(e.target.value)} />
        </label>
        <label>
          管理员密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="button" onClick={() => void save()}>
          保存小程序配置
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
