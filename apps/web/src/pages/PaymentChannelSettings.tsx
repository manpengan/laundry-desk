import { useEffect, useRef, useState } from "react";
import { PaymentCredentialSchema, type PaymentChannelSettings } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
const common = [
  { key: "appId", label: "应用 AppID", secret: false },
  { key: "privateKey", label: "商户私钥 PEM", secret: true },
  { key: "platformPublicKey", label: "平台验签公钥 PEM", secret: true },
  { key: "notifyUrl", label: "支付回调 HTTPS 地址", secret: false },
];
const fields = {
  wechat: [
    ...common,
    { key: "merchantId", label: "微信商户号", secret: false },
    { key: "merchantSerial", label: "商户证书序列号", secret: false },
    { key: "platformKeyId", label: "微信支付公钥 ID", secret: false },
    { key: "apiV3Key", label: "API v3 密钥", secret: true },
  ],
  alipay: [...common, { key: "sellerId", label: "支付宝商户 PID", secret: false }],
};
export function PaymentChannelSettings({ port }: Readonly<{ port: PaymentChannelPort }>) {
  const [view, setView] = useState<PaymentChannelSettings | null>(null);
  const [channel, setChannel] = useState<"wechat" | "alipay">("wechat");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [password, setPassword] = useState("");
  const [replace, setReplace] = useState(false),
    [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0);
  const setting = view?.settings.find((entry) => entry.channel === channel);
  useEffect(() => {
    const current = ++generation.current;
    void port.settings().then((result) => {
      if (current !== generation.current) return;
      if (result.ok) setView(result.data);
      else setMessage(result.error);
    });
    return () => {
      generation.current++;
    };
  }, [port]);
  useEffect(() => {
    setEnabled(setting?.enabled ?? false);
    setReplace(false);
    setValues({});
    setPassword("");
  }, [channel, setting]);
  const save = async () => {
    if (!view?.custody_available || !password || busy) return;
    const current = generation.current;
    const credential =
      replace || !setting ? PaymentCredentialSchema.safeParse({ channel, ...values }) : null;
    if (credential && !credential.success) {
      setMessage("请填写完整、格式正确的商户凭据；PEM 请保留换行。");
      return;
    }
    const body = {
      channel,
      enabled,
      expected_version: setting?.version ?? 0,
      password,
      ...(credential?.success ? { credential: credential.data } : {}),
    };
    setPassword("");
    setValues({});
    setBusy(true);
    setMessage("");
    const result = await port.save(body);
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) {
      setView(result.data);
      setReplace(false);
      setMessage("支付渠道设置已保存。");
    } else setMessage(result.error + " 如需更换凭据，请重新填写后提交。");
  };
  return (
    <section className="space-y-3" aria-label="支付商户设置">
      <h3>商户设置</h3>
      <p>凭据由本机服务加密保管，保存后不回显。每次启停或更换需当前管理员密码。</p>
      {view && !view.custody_available && (
        <p role="status">当前服务未启用 Windows 密钥保管，暂不能保存支付凭据。</p>
      )}
      <label>
        支付渠道{" "}
        <select
          value={channel}
          disabled={busy}
          onChange={(e) => setChannel(e.target.value === "alipay" ? "alipay" : "wechat")}
        >
          <option value="wechat">微信支付</option>
          <option value="alipay">支付宝</option>
        </select>
      </label>
      {setting && (
        <p>
          已配置商户：{setting.merchant_id}；应用：{setting.app_id}
        </p>
      )}
      <label className="block">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        启用该渠道
      </label>
      {setting && (
        <label className="block">
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            onChange={(e) => {
              setReplace(e.target.checked);
              setValues({});
            }}
          />{" "}
          更换商户凭据
        </label>
      )}
      {(replace || !setting) &&
        fields[channel].map((field) => (
          <label className="block" key={field.key}>
            {field.label}
            {field.key.endsWith("Key") && field.key !== "apiV3Key" ? (
              <textarea
                className="block w-full rounded border p-2"
                rows={3}
                autoComplete="off"
                spellCheck={false}
                maxLength={8192}
                value={values[field.key] ?? ""}
                disabled={busy}
                onChange={(e) => setValues((prior) => ({ ...prior, [field.key]: e.target.value }))}
              />
            ) : (
              <input
                className="block w-full rounded border p-2"
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                maxLength={512}
                value={values[field.key] ?? ""}
                disabled={busy}
                onChange={(e) => setValues((prior) => ({ ...prior, [field.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
      <label className="block">
        当前管理员密码{" "}
        <input
          type="password"
          autoComplete="current-password"
          maxLength={256}
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border p-2"
        />
      </label>
      <button
        type="button"
        disabled={busy || !view?.custody_available || !password}
        onClick={() => void save()}
        className="rounded border px-3 py-2"
      >
        保存支付设置
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
