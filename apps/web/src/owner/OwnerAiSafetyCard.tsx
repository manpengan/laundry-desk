import { useEffect, useState } from "react";

import type { AiSafetyStatusView } from "@laundry/contracts";

import type { AiPanelPort } from "../host/ai-port.js";

export function OwnerAiSafetyView({ status }: Readonly<{ status: AiSafetyStatusView }>) {
  return (
    <dl data-state="ready">
      <div>
        <dt>运行状态</dt>
        <dd>{status.runtime_enabled ? "已启用" : "默认关闭"}</dd>
      </div>
      <div>
        <dt>{status.month} 用量</dt>
        <dd>{status.input_tokens + status.output_tokens} tokens</dd>
      </div>
      <div>
        <dt>估算成本 / 月限额</dt>
        <dd>
          {status.estimated_cost_micros} / {status.monthly_limit_micros} 微单位
        </dd>
      </div>
      <div>
        <dt>熔断器</dt>
        <dd>{status.circuit_state === "closed" ? "正常" : "已熔断"}</dd>
      </div>
      <div>
        <dt>隐私与出口</dt>
        <dd>PII 脱敏开启 · HTTPS 443 白名单</dd>
      </div>
    </dl>
  );
}

export function OwnerAiSafetyCard({ aiPort }: Readonly<{ aiPort: AiPanelPort }>) {
  const [status, setStatus] = useState<AiSafetyStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void aiPort
      .getSafetyStatus()
      .then((result) => {
        if (!active) return;
        if (result.ok) setStatus(result.data);
        else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError("无法读取 AI 安全状态");
      });
    return () => {
      active = false;
    };
  }, [aiPort]);

  return (
    <section className="lg-card ld-owner-ai-safety" aria-labelledby="owner-ai-safety-title">
      <h2 id="owner-ai-safety-title">AI 安全与用量</h2>
      {error !== null ? <p role="alert">{error}</p> : null}
      {status === null ? (
        error === null ? (
          <p>正在读取安全状态…</p>
        ) : null
      ) : (
        <OwnerAiSafetyView status={status} />
      )}
    </section>
  );
}
