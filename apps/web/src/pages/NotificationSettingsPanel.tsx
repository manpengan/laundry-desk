import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, MoneyInput } from "@laundry/ui";
import type { NotificationProviderSettingsView } from "@laundry/contracts";
import type { NotificationSettingsPort } from "../host/notification-settings-port.js";

type Save = NotificationSettingsPort["save"];

export function NotificationSettingsPanel({
  port,
  sessionKey,
}: Readonly<{
  port: NotificationSettingsPort;
  sessionKey: string;
}>) {
  const [view, setView] = useState<NotificationProviderSettingsView | null>(null);
  const [message, setMessage] = useState("正在读取短信设置…");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setView(null);
    setMessage("正在读取短信设置…");
    void port.read().then((result) => {
      if (generation.current !== current) return;
      if (result.ok) {
        setView(result.data);
        setMessage("");
      } else setMessage("暂时读不到短信设置。请确认本地服务在运行，稍后刷新页面再看。");
    });
    return () => {
      generation.current++;
    };
  }, [port, sessionKey]);
  const save: Save = async (input) => {
    const current = generation.current;
    const result = await port.save(input);
    if (generation.current === current) {
      if (result.ok) setView(result.data);
      setMessage(result.ok ? "短信设置已保存。" : result.error);
    }
    return result;
  };
  return (
    <section className="ld-settings-section lg-card ld-panel" aria-label="阿里云短信设置">
      <header className="ld-settings-section__head">
        <h2>阿里云短信</h2>
        <p>保存设置不会发送短信；启用后可在催取提醒中预览并确认发送。</p>
      </header>
      <div className="ld-panel__note">
        在阿里云申请模板时，变量请使用 <code>{"${tickets}"}</code>（票号）、
        <code>{"${garment_count}"}</code>（件数）、<code>{"${balance_yuan}"}</code>
        （欠款，单位元，如 20.00）。例如：您的洗衣订单{"${tickets}"}共{"${garment_count}"}
        件已可取，尚欠{"${balance_yuan}"}元，请方便时到店取衣。
      </div>
      <p className="ld-panel__lead">
        密钥由当前 Windows
        账户保护，换机后需要重新配置。发送结果不明时会转为人工处理，避免重复发送。有未结束的短信时仍可启停服务或更换密钥；签名、模板和费用要等原批次处理完再改。
      </p>
      {message ? (
        <p className="ld-panel__note" role="status">
          {message}
        </p>
      ) : null}
      {view && (
        <NotificationSettingsForm
          key={`${sessionKey}:${view.settings?.version ?? 0}`}
          view={view}
          save={save}
          onInvalid={setMessage}
        />
      )}
    </section>
  );
}

function NotificationSettingsForm({
  view,
  save,
  onInvalid,
}: Readonly<{
  view: NotificationProviderSettingsView;
  save: Save;
  onInvalid: (message: string) => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [unitCost, setUnitCost] = useState(String(view.settings?.unit_cost_cents ?? ""));
  const [maxCost, setMaxCost] = useState(String(view.settings?.max_batch_cost_cents ?? ""));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !view.custody_available) return;
    const unit = Number(unitCost),
      max = Number(maxCost);
    if (!(unit >= 1 && unit <= 1000 && max >= 1 && max <= 50000)) {
      onInvalid("每条费用须在 0.01–10 元之间，每批上限须在 0.01–500 元之间。");
      return;
    }
    const form = event.currentTarget;
    const values = new FormData(form);
    const field = (name: string) => String(values.get(name) ?? "");
    const credential =
      field("accessKeyId") || field("accessKeySecret")
        ? { accessKeyId: field("accessKeyId"), accessKeySecret: field("accessKeySecret") }
        : undefined;
    setBusy(true);
    try {
      await save({
        provider: "aliyun_sms",
        expected_version: view.settings?.version ?? 0,
        enabled: values.get("enabled") === "on",
        sign_name: field("signName"),
        template_code: field("templateCode"),
        unit_cost_cents: unit,
        max_batch_cost_cents: max,
        password: field("password"),
        ...(credential === undefined ? {} : { credential }),
      });
    } finally {
      for (const name of ["password", "accessKeyId", "accessKeySecret"]) {
        const input = form.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <fieldset className="ld-panel" disabled={busy || !view.custody_available}>
        <label className="ld-panel__check">
          <input type="checkbox" name="enabled" defaultChecked={view.settings?.enabled ?? false} />
          启用阿里云短信
        </label>
        <div className="ld-panel__grid">
          <Input
            name="signName"
            label="已批准签名"
            required
            minLength={2}
            maxLength={12}
            defaultValue={view.settings?.sign_name ?? ""}
          />
          <Input
            name="templateCode"
            label="模板编码"
            hint="形如 SMS_123456789"
            required
            pattern="SMS_[0-9]{1,32}"
            defaultValue={view.settings?.template_code ?? ""}
          />
          <MoneyInput
            name="unitCost"
            label="每条费用（元）"
            hint="按阿里云套餐单价估算，例如 0.045 元填 0.05"
            valueFen={unitCost}
            onChangeFen={setUnitCost}
          />
          <MoneyInput
            name="maxCost"
            label="每批费用上限（元）"
            hint="一次催取超过这个金额将不会发送"
            valueFen={maxCost}
            onChangeFen={setMaxCost}
          />
        </div>
        <p className="ld-panel__lead">
          {view.credential_present
            ? "已保存凭据；两项都留空则保留现有凭据。"
            : "首次设置需填写两项凭据。"}
        </p>
        <div className="ld-panel__grid">
          <Input
            name="accessKeyId"
            label="AccessKey ID"
            autoComplete="off"
            required={!view.credential_present}
            maxLength={128}
          />
          <Input
            name="accessKeySecret"
            label="AccessKey Secret"
            type="password"
            autoComplete="new-password"
            required={!view.credential_present}
            maxLength={256}
          />
          <Input
            name="password"
            label="当前管理员密码"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
          />
        </div>
        <div className="ld-panel__actions">
          <Button type="submit">{busy ? "正在保存…" : "保存短信设置"}</Button>
        </div>
      </fieldset>
    </form>
  );
}
