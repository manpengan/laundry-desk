import { Button, Input } from "@laundry/ui";
import { useEffect, useState } from "react";
import { AiRuntimeConfigRequestSchema, type AiRuntimeConfigRequest } from "@laundry/contracts";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AiSettingsPort } from "./settings-port.js";
import { AiCredentialSettings } from "./AiCredentialSettings.js";

const initial: AiRuntimeConfigRequest = {
  enabled: false,
  provider_code: "deepseek",
  model_id: "",
  monthly_limit_micros: 0,
  input_micros_per_million: 0,
  output_micros_per_million: 0,
  expected_version: 0,
};

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
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取 AI 配置…");
  useEffect(() => {
    let current = true;
    void port.config().then((result) => {
      if (!current) return;
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setAvailable(result.data.custody_available);
      const config = result.data.config;
      if (config !== null) {
        const { version, ...settings } = config;
        setValue({ ...settings, expected_version: version });
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
    const input = AiRuntimeConfigRequestSchema.safeParse(value);
    if (!input.success) {
      setMessage("请填写模型标识、正整数月预算和计费单价。");
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
        setValue({ ...value, expected_version: result.data.config.version });
      setMessage(value.enabled ? "AI 已启用，后续请求受月预算与熔断限制。" : "AI 已停用。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="AI 配置">
      <h2>AI 助手与密钥</h2>
      <p>
        只读助手可查询授权范围内的信息。联网请求可能产生服务商费用；预算是本地估算，请按同一账单币种填写价格。
      </p>
      <label>
        服务商
        <select
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
      {(
        [
          ["monthly_limit_micros", "每月预算"],
          ["input_micros_per_million", "每百万输入 token 单价"],
          ["output_micros_per_million", "每百万输出 token 单价"],
        ] as const
      ).map(([field, label]) => (
        <Input
          key={field}
          label={`${label}（微单位，1 单位 = 1,000,000）`}
          type="number"
          min={1}
          step={1}
          disabled={busy}
          value={String(value[field])}
          onChange={(event) => setValue({ ...value, [field]: Number(event.target.value) })}
        />
      ))}
      <label>
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={busy}
          onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
        />
        启用 AI 联网助手
      </label>
      <Button disabled={busy || !available} onClick={() => void save()}>
        {busy ? "保存中…" : value.enabled ? "联网验证模型并保存配置" : "保存停用配置"}
      </Button>
      <p role="status">{message}</p>
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
