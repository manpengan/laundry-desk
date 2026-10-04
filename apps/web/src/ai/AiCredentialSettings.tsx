import { Button, Input } from "@laundry/ui";
import { useEffect, useState } from "react";
import type { AiCredentialMetadata } from "@laundry/contracts";
import type { AuthClient } from "../auth/AuthClient.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import type { AiSettingsPort } from "./settings-port.js";

const statusLabels = {
  pending_verification: "待验证",
  active: "已激活",
  invalid: "无效",
  superseded: "已轮换",
  revoked: "已撤销",
};
type Pending = Readonly<{
  ref: string;
  operation: "replace" | "revoke";
  credential?: string;
  provider: string;
}>;

export function AiCredentialSettings({
  port,
  authClient,
  staffId,
  provider,
  model,
  available,
}: Readonly<{
  port: AiSettingsPort;
  authClient: AuthClient;
  staffId: string;
  provider: string;
  model: string;
  available: boolean;
}>) {
  const [items, setItems] = useState<readonly AiCredentialMetadata[]>([]);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const reload = async () => {
    const result = await port.credentials();
    if (result.ok) setItems(result.data.items);
    else setMessage(result.error.message);
  };
  useEffect(() => {
    let current = true;
    void port.credentials().then((result) => {
      if (current && result.ok) setItems(result.data.items);
    });
    return () => {
      current = false;
    };
  }, [port]);
  const intent = async (credential?: AiCredentialMetadata) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await port.intent(
        credential === undefined
          ? { operation: "replace", provider_code: provider, idempotency_key: crypto.randomUUID() }
          : {
              operation: "revoke",
              provider_code: credential.provider_code,
              credential_ref: credential.credential_ref,
              idempotency_key: crypto.randomUUID(),
            },
      );
      if (!result.ok) {
        setKey("");
        setMessage(result.error.message);
        return;
      }
      setPending({
        ref: result.data.confirm_ref,
        operation: credential === undefined ? "replace" : "revoke",
        provider: result.data.provider_code,
        ...(credential === undefined ? {} : { credential: credential.credential_ref }),
      });
    } finally {
      setBusy(false);
    }
  };
  const apply = async (proof: string) => {
    const action = pending;
    const secret = key;
    setKey("");
    setPending(null);
    if (action === null) return;
    setBusy(true);
    try {
      const result =
        action.operation === "replace"
          ? await port.replace(action.ref, proof, secret)
          : await port.revoke(action.credential ?? "", action.ref, proof);
      setMessage(
        result.ok
          ? action.operation === "replace"
            ? "密钥已安全保存，请联网验证并激活。"
            : "密钥已撤销。"
          : result.error.message,
      );
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const validate = async (credential: AiCredentialMetadata) => {
    setBusy(true);
    try {
      const result = await port.validate(credential.credential_ref, model);
      setMessage(
        result.ok && result.data.outcome === "valid"
          ? "密钥已验证并激活。"
          : "验证未通过，请检查密钥和模型名称。",
      );
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ld-panel__sub" aria-label="AI 密钥管理">
      <h3>服务商密钥</h3>
      <p className="ld-panel__lead">
        密钥只在这台 Windows
        电脑的当前运行账户下解密。更换账户或电脑后需重新录入；配置备份不会导出明文密钥。
      </p>
      <Input
        label="新的 API 密钥"
        type="password"
        autoComplete="off"
        value={key}
        maxLength={8192}
        disabled={busy || pending !== null || !available}
        onChange={(event) => setKey(event.target.value)}
      />
      <div className="ld-panel__actions">
        <Button
          disabled={busy || !available || key.length < 8 || pending !== null}
          onClick={() => void intent()}
        >
          保存或轮换密钥（需复核）
        </Button>
      </div>
      <ul className="ld-panel__list">
        {items.map((item) => (
          <li className="ld-panel__item" key={item.credential_ref}>
            <span>
              {item.provider_code} · 尾号 {item.last4} · {statusLabels[item.status]}
              <span className="ld-panel__meta"> · 版本 {item.credential_version}</span>
            </span>
            <span className="ld-panel__actions">
              {item.status === "pending_verification" && item.provider_code === provider ? (
                <Button size="sm" disabled={busy || !model} onClick={() => void validate(item)}>
                  联网验证并激活
                </Button>
              ) : null}
              {item.status === "active" || item.status === "pending_verification" ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void intent(item)}>
                  撤销（需复核）
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {message ? (
        <p className="ld-panel__note" role="status">
          {message}
        </p>
      ) : null}
      {pending === null ? null : (
        <StepUpConfirmDialog
          open
          authClient={authClient}
          confirmRef={pending.ref}
          currentStaffId={staffId}
          commandLabel={pending.operation === "replace" ? "保存 AI 密钥" : "撤销 AI 密钥"}
          summary={
            <p>
              服务商：{pending.provider}。
              {pending.operation === "replace"
                ? "新密钥需要联网验证后才会生效。"
                : "撤销后无法再使用此密钥。"}
            </p>
          }
          onClose={() => {
            setPending(null);
            setKey("");
          }}
          onApproved={(proof) => void apply(proof.step_up_proof_id)}
        />
      )}
    </section>
  );
}
