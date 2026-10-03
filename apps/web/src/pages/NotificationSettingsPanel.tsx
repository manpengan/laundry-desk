import { useEffect, useRef, useState, type FormEvent } from "react";
import type { NotificationProviderSettingsView } from "@laundry/contracts";
import type { NotificationSettingsPort } from "../host/notification-settings-port.js";

export function NotificationSettingsPanel({
  port,
  sessionKey,
}: Readonly<{
  port: NotificationSettingsPort;
  sessionKey: string;
}>) {
  const [view, setView] = useState<NotificationProviderSettingsView | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setView(null);
    setMessage("");
    setBusy(false);
    void port.read().then((result) => {
      if (generation.current !== current) return;
      if (result.ok) setView(result.data);
      else setMessage(result.error);
    });
    return () => {
      generation.current++;
    };
  }, [port, sessionKey]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || view === null || !view.custody_available) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const field = (name: string) => String(values.get(name) ?? "");
    const credential =
      field("accessKeyId") || field("accessKeySecret")
        ? { accessKeyId: field("accessKeyId"), accessKeySecret: field("accessKeySecret") }
        : undefined;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const result = await port.save({
      provider: "aliyun_sms",
      expected_version: view.settings?.version ?? 0,
      enabled: values.get("enabled") === "on",
      sign_name: field("signName"),
      template_code: field("templateCode"),
      unit_cost_cents: Number(field("unitCost")),
      max_batch_cost_cents: Number(field("maxCost")),
      password: field("password"),
      ...(credential === undefined ? {} : { credential }),
    });
    for (const name of ["password", "accessKeyId", "accessKeySecret"]) {
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = "";
    }
    if (generation.current !== current) return;
    setBusy(false);
    if (result.ok) {
      setView(result.data);
      setMessage("短信设置已保存。");
    } else setMessage(result.error);
  };
  return (
    <section aria-label="阿里云短信设置">
      <p>
        填写已获批准的阿里云短信签名和模板。模板参数须包含 tickets、garment_count、balance_cents。
        保存设置不会发送短信；启用后可在催取提醒中预览并确认发送。
      </p>
      <p>
        密钥由当前 Windows
        账户保护。换机后需要重新配置。发送结果不明时会转为人工处理，避免重复发送。
      </p>
      {message && <p role="status">{message}</p>}
      <p>有未结束短信时，仍可启停服务或轮换密钥；签名、模板和费用需待原批次处理完毕后修改。</p>
      {view && (
        <form
          key={`${sessionKey}:${view.settings?.version ?? 0}`}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <fieldset disabled={busy || !view.custody_available}>
            <legend>短信服务与费用</legend>
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={view.settings?.enabled ?? false}
              />
              启用阿里云短信
            </label>
            <label>
              已批准签名
              <input
                name="signName"
                required
                minLength={2}
                maxLength={12}
                defaultValue={view.settings?.sign_name ?? ""}
              />
            </label>
            <label>
              模板编码
              <input
                name="templateCode"
                required
                pattern="SMS_[0-9]{1,32}"
                defaultValue={view.settings?.template_code ?? ""}
              />
            </label>
            <label>
              每条费用（分）
              <input
                name="unitCost"
                type="number"
                required
                min={1}
                max={1000}
                defaultValue={view.settings?.unit_cost_cents ?? ""}
              />
            </label>
            <label>
              每批费用上限（分）
              <input
                name="maxCost"
                type="number"
                required
                min={1}
                max={50000}
                defaultValue={view.settings?.max_batch_cost_cents ?? ""}
              />
            </label>
            <p>
              {view.credential_present
                ? "已保存凭据；留空保留现有凭据。"
                : "首次设置需填写两项凭据。"}
            </p>
            <label>
              AccessKey ID
              <input
                name="accessKeyId"
                autoComplete="off"
                required={!view.credential_present}
                maxLength={128}
              />
            </label>
            <label>
              AccessKey Secret
              <input
                name="accessKeySecret"
                type="password"
                autoComplete="new-password"
                required={!view.credential_present}
                maxLength={256}
              />
            </label>
            <label>
              当前管理员密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
              />
            </label>
            <button type="submit">{busy ? "正在保存…" : "保存短信设置"}</button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
