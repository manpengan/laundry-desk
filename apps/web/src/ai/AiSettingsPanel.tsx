import { Button, Input } from "@laundry/ui";
import { useEffect, useState } from "react";
import { AiRuntimeConfigRequestSchema, type AiRuntimeConfigRequest } from "@laundry/contracts";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AiSettingsPort } from "./settings-port.js";
import { AiCredentialSettings } from "./AiCredentialSettings.js";
import { microsToYuan, yuanToMicros } from "./ai-money.js";

const initial: AiRuntimeConfigRequest = {
  enabled: false,
  provider_code: "deepseek",
  model_id: "",
  monthly_limit_micros: 0,
  input_micros_per_million: 0,
  output_micros_per_million: 0,
  expected_version: 0,
};
const AMOUNTS = [
  ["monthly_limit_micros", "每月预算（元）", "到达后当月不再发起联网请求"],
  ["input_micros_per_million", "每百万输入 token 单价（元）", "按服务商价目表填写，例如 2"],
  ["output_micros_per_million", "每百万输出 token 单价（元）", "按服务商价目表填写，例如 8"],
] as const;
type AmountField = (typeof AMOUNTS)[number][0];
type Amounts = Readonly<Record<AmountField, string>>;
const yuan = (micros: number) => (micros > 0 ? microsToYuan(micros) : "");
const amountsOf = (value: AiRuntimeConfigRequest): Amounts => ({
  monthly_limit_micros: yuan(value.monthly_limit_micros),
  input_micros_per_million: yuan(value.input_micros_per_million),
  output_micros_per_million: yuan(value.output_micros_per_million),
});

export function AiSettingsPanel({
  port,
  authClient,
  staffId,
}: Readonly<{
  port: AiSettingsPort;
  authClient: AuthClient;
  staffId: string;
}>) {
  const [value, setValue] = useState(initial);
  const [amounts, setAmounts] = useState<Amounts>(() => amountsOf(initial));
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取 AI 配置…");
  useEffect(() => {
    let current = true;
    void port.config().then((result) => {
      if (!current) return;
      if (!result.ok) {
        setMessage("暂时读不到 AI 配置。请确认本地服务在运行，稍后刷新页面再看。");
        return;
      }
      setAvailable(result.data.custody_available);
      const config = result.data.config;
      if (config !== null) {
        const { version, ...settings } = config;
        const next = { ...settings, expected_version: version };
        setValue(next);
        setAmounts(amountsOf(next));
      }
      setMessage(
        result.data.custody_available
          ? ""
          : "本机密钥托管尚未就绪，请从 Windows 安装版本运行服务。",
      );
    });
    return () => {
      current = false;
    };
  }, [port]);
  const save = async () => {
    const micros = AMOUNTS.map(([field]) => [field, yuanToMicros(amounts[field])] as const);
    const input = AiRuntimeConfigRequestSchema.safeParse({
      ...value,
      ...Object.fromEntries(micros.map(([field, amount]) => [field, amount ?? 0])),
    });
    if (!input.success || micros.some(([, amount]) => amount === null)) {
      setMessage("请填写模型标识，以及大于 0 的预算和单价（元，最多 6 位小数）。");
      return;
    }
    setBusy(true);
    try {
      const result = await port.save(input.data);
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      if (result.data.config !== null)
        setValue({ ...input.data, expected_version: result.data.config.version });
      setMessage(input.data.enabled ? "AI 已启用，后续请求受月预算与熔断限制。" : "AI 已停用。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ld-settings-section lg-card ld-panel" aria-label="AI 配置">
      <header className="ld-settings-section__head">
        <h2>AI 助手与密钥</h2>
        <p>
          只读助手可查询授权范围内的信息。联网请求可能产生服务商费用；预算是本地估算，金额按服务商账单币种填写。
        </p>
      </header>
      <div className="ld-panel__grid">
        <label className="ld-field">
          <span className="ld-field__label">服务商</span>
          <select
            className="ld-input"
            value={value.provider_code}
            disabled={busy}
            onChange={(event) => {
              const provider = event.target.value;
              if (provider === "deepseek" || provider === "anthropic" || provider === "gemini")
                setValue({ ...value, provider_code: provider, model_id: "" });
            }}
          >
            <option value="deepseek">DeepSeek</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <Input
          label="模型标识（服务商控制台中的精确名称）"
          value={value.model_id}
          maxLength={128}
          disabled={busy}
          onChange={(event) => setValue({ ...value, model_id: event.target.value })}
        />
        {AMOUNTS.map(([field, label, hint]) => (
          <Input
            key={field}
            label={label}
            inputMode="decimal"
            hint={hint}
            disabled={busy}
            value={amounts[field]}
            onChange={(event) => setAmounts({ ...amounts, [field]: event.target.value })}
          />
        ))}
      </div>
      <label className="ld-panel__check">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={busy}
          onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
        />
        启用 AI 联网助手
      </label>
      <p className="ld-panel__lead">
        系统会在服务商用量明显异常，或 24 小时内 3 次无法核实用量时自动停用
        AI。请先到服务商后台核对账单，再勾选启用并保存；保存即视为已核对，会记入审计。
      </p>
      <div className="ld-panel__actions">
        <Button disabled={busy || !available} onClick={() => void save()}>
          {busy ? "保存中…" : value.enabled ? "联网验证模型并保存配置" : "保存停用配置"}
        </Button>
      </div>
      {message ? (
        <p className="ld-panel__note" role="status">
          {message}
        </p>
      ) : null}
      <AiCredentialSettings
        port={port}
        authClient={authClient}
        staffId={staffId}
        available={available}
        provider={value.provider_code}
        model={value.model_id}
      />
    </section>
  );
}
