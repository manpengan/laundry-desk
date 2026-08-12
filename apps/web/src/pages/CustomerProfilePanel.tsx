import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { CustomerProfileForm } from "./CustomerProfileForm.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import type { CustomerRowView } from "./customer-model.js";
import {
  buildCustomerDiscountBody,
  buildCustomerProfileBody,
  discountModeFor,
  formatDiscountPercent,
  parseCustomerProfile,
  profileDraftFromView,
  type CustomerProfileDraft,
  type CustomerProfileView,
  type DiscountMode,
} from "./customer-profile-model.js";

type PendingAction = Readonly<{
  command: "customer.profile.set" | "customer.discount_policy.set";
  confirmRef: string;
  kind: "confirm" | "step_up";
  label: string;
}>;

export type CustomerProfilePanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
}>;

export function CustomerProfilePanel({
  customer,
  queryClient,
  commandClient,
  authClient,
  session,
}: CustomerProfilePanelProps) {
  const toast = useToast();
  const requestRef = useRef(0);
  const [profile, setProfile] = useState<CustomerProfileView | null>(null);
  const [draft, setDraft] = useState<CustomerProfileDraft | null>(null);
  const [discountMode, setDiscountMode] = useState<DiscountMode>("inherit");
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const applyProfile = useCallback((next: CustomerProfileView) => {
    setProfile(next);
    setDraft(profileDraftFromView(next));
    setDiscountMode(discountModeFor(next.discount_bps));
    setDiscountPercent(next.discount_bps === null ? "" : formatDiscountPercent(next.discount_bps));
    setDiscountReason("");
    setFailed(false);
    setLoaded(true);
  }, []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("customer.profile.get", {
        customer_id: customer.customer_id,
      });
      if (request !== requestRef.current) return;
      if (!result.ok) {
        setFailed(true);
        setLoaded(true);
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseCustomerProfile(result.data);
      if (parsed === null || parsed.customer_id !== customer.customer_id) {
        setFailed(true);
        setLoaded(true);
        toast.push("顾客扩展档案响应无法解析", "error");
        return;
      }
      applyProfile(parsed);
    } catch {
      if (request !== requestRef.current) return;
      setFailed(true);
      setLoaded(true);
      toast.push("顾客扩展档案加载失败", "error");
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [applyProfile, customer.customer_id, queryClient, toast]);

  useEffect(() => {
    setProfile(null);
    setDraft(null);
    setLoaded(false);
    setFailed(false);
    setPending(null);
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const run = useCallback(
    async (
      command: PendingAction["command"],
      body: Readonly<Record<string, unknown>>,
      label: string,
    ) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (result.ok) {
          toast.push(`${label}完成`, "success");
          await load();
          return;
        }
        if (isStepUpRequired(result)) {
          setPending(
            Object.freeze({
              command,
              confirmRef: result.error.detail.confirm_ref,
              kind: result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
              label,
            }),
          );
          return;
        }
        if (result.error.code === "INVARIANT_FAILED") {
          toast.push("档案已被其他操作更新，已重新读取", "error");
          await load();
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } catch {
        toast.push(`${label}失败，请刷新确认`, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, load, toast],
  );

  const resume = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        pending.command,
        {},
        { confirmRef: pending.confirmRef },
      );
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        setPending(null);
        await load();
        return;
      }
      toast.push(`${pending.label}完成`, "success");
      setPending(null);
      await load();
    } catch {
      toast.push(`${pending.label}失败，请刷新确认`, "error");
    } finally {
      setBusy(false);
    }
  }, [commandClient, load, pending, toast]);

  if (!loaded) {
    return (
      <section className="ld-customer-profile">
        <h3>扩展档案与政策</h3>
        <p>读取中…</p>
      </section>
    );
  }
  if (failed || profile === null || draft === null) {
    return (
      <section className="ld-customer-profile">
        <h3>扩展档案与政策</h3>
        <p role="alert">档案读取失败或响应格式无效。</p>
        <Button type="button" onClick={() => void load()} disabled={busy}>
          重试
        </Button>
      </section>
    );
  }

  const saveProfile = (): void => {
    const built = buildCustomerProfileBody(customer.customer_id, profile.version, draft);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void run("customer.profile.set", built.body, "顾客扩展档案更新");
  };
  const saveDiscount = (): void => {
    const built = buildCustomerDiscountBody(
      customer.customer_id,
      profile.version,
      discountMode,
      discountPercent,
      discountReason,
    );
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void run("customer.discount_policy.set", built.body, "顾客折扣政策更新");
  };

  return (
    <section className="ld-customer-profile" data-testid="customer-profile-panel">
      <div className="ld-customer-profile__head">
        <div>
          <h3>扩展档案与政策</h3>
          <p>版本 {profile.version}；地址、标识、服务偏好与运营豁免属于组织级档案。</p>
        </div>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void load()}>
          重新读取
        </Button>
      </div>

      <CustomerProfileForm draft={draft} busy={busy} onChange={setDraft} onSave={saveProfile} />

      <section className="ld-customer-profile__discount" aria-label="顾客折扣政策">
        <h4>自动折扣政策</h4>
        <p>
          当前：
          {profile.discount_bps === null
            ? "继承有效会员等级"
            : profile.discount_bps === 0
              ? "明确不使用等级折扣"
              : `顾客专属 ${formatDiscountPercent(profile.discount_bps)}%`}
          。新订单由服务端计算并冻结，优惠券不叠加。
        </p>
        {session?.role === "admin" ? (
          <div className="ld-customer-profile__discount-fields">
            <label>
              <span>政策</span>
              <select
                value={discountMode}
                disabled={busy}
                onChange={(event) => setDiscountMode(event.target.value as DiscountMode)}
              >
                <option value="inherit">继承有效会员等级</option>
                <option value="disabled">明确不自动打折</option>
                <option value="customer">顾客专属折扣</option>
              </select>
            </label>
            {discountMode === "customer" ? (
              <Input
                name="customer-discount-percent"
                label="折扣百分比"
                value={discountPercent}
                inputMode="decimal"
                disabled={busy}
                onChange={(event) => setDiscountPercent(event.target.value)}
                data-testid="customer-discount-percent"
              />
            ) : null}
            <Input
              name="customer-discount-reason"
              label="折扣变更原因"
              value={discountReason}
              maxLength={256}
              disabled={busy}
              onChange={(event) => setDiscountReason(event.target.value)}
            />
            <Button
              variant="primary"
              type="button"
              disabled={busy}
              onClick={saveDiscount}
              data-testid="customer-discount-save"
            >
              保存折扣政策
            </Button>
          </div>
        ) : (
          <p>仅管理员可修改自动折扣政策。</p>
        )}
      </section>

      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认顾客档案变更"
        description="服务端已冻结本次参数；确认后将更新档案版本并写入审计。"
        confirmLabel="确认保存"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => void resume()}
      />
      {pending?.kind === "step_up" && authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={pending.label}
          onApproved={() => void resume()}
        />
      ) : null}
    </section>
  );
}
