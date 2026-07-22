/**
 * Settings surface — M1 demo: R5 platform.settings.set with step-up PIN resume.
 */

import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";

export type SettingsPageProps = {
  session: AccessSession;
  authClient: AuthClient;
  commandClient: CommandPort;
};

const SETTINGS_KEY = "pricing.min_order_cents";

export function SettingsPage({ session, authClient, commandClient }: SettingsPageProps) {
  const toast = useToast();
  const [centsText, setCentsText] = useState("1200");
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  const finishConfirm = useCallback(
    async (confirmRef: string, valueJson: string) => {
      const second = await commandClient.execute("platform.settings.set", {}, { confirmRef });
      if (!second.ok) {
        toast.push(second.error.message ?? second.error.code, "error");
        return;
      }
      setLastSaved(valueJson);
      toast.push("设置已保存（复核通过）", "success");
    },
    [commandClient, toast],
  );

  const onSave = useCallback(async () => {
    const trimmed = centsText.trim();
    if (!/^\d+$/u.test(trimmed)) {
      toast.push("请输入整数分（如 1200）", "error");
      return;
    }
    setBusy(true);
    try {
      const first = await commandClient.execute("platform.settings.set", {
        entries: [{ key: SETTINGS_KEY, value_json: trimmed }],
      });
      if (first.ok) {
        setLastSaved(trimmed);
        toast.push("设置已保存", "success");
        return;
      }
      if (isStepUpRequired(first)) {
        setPendingRef(first.error.detail.confirm_ref);
        setPendingValue(trimmed);
        return;
      }
      toast.push(first.error.message ?? first.error.code, "error");
    } finally {
      setBusy(false);
    }
  }, [centsText, commandClient, toast]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">设置</h1>
      <p className="ld-shell-main__hint">
        R5「最低消费」写入需现场 PIN 复核（A5/ADR-05：不可自核，不切换当前员工）。
      </p>
      <div className="ld-settings-form">
        <Input
          name="min-order-cents"
          label="最低消费（分）"
          inputMode="numeric"
          value={centsText}
          onChange={(event) => setCentsText(event.target.value)}
          hint="示例：1200 表示 ¥12.00；整数分，零浮点"
          disabled={busy}
        />
        <div className="ld-settings-form__actions">
          <Button variant="primary" type="button" onClick={() => void onSave()} disabled={busy}>
            {busy ? "提交中…" : "保存（可能需复核）"}
          </Button>
        </div>
        {lastSaved !== null ? (
          <p className="ld-settings-form__saved" role="status">
            当前已保存：{lastSaved} 分
          </p>
        ) : null}
      </div>
      <StepUpConfirmDialog
        open={pendingRef !== null}
        onClose={() => {
          setPendingRef(null);
          setPendingValue(null);
        }}
        authClient={authClient}
        confirmRef={pendingRef ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="修改最低消费"
        onApproved={() => {
          const ref = pendingRef;
          const value = pendingValue;
          setPendingRef(null);
          setPendingValue(null);
          if (ref !== null && value !== null) {
            void finishConfirm(ref, value);
          }
        }}
      />
    </main>
  );
}
