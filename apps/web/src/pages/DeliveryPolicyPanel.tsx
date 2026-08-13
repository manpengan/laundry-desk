import {
  DeliveryPolicyConfirmationSummarySchema,
  type DeliveryPolicyConfirmationSummary,
} from "@laundry/contracts";
import { useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DeliveryAvailabilityQuoteForm } from "./DeliveryAvailabilityQuoteForm.js";
import { DeliveryPolicyConfirmationSummaryView } from "./DeliveryPolicyConfirmationSummary.js";
import { DeliveryPolicyEditor } from "./DeliveryPolicyEditor.js";
import {
  EMPTY_DELIVERY_POLICY_DRAFT,
  buildDeliveryPolicyInput,
  readDeliveryPolicy,
  type DeliveryPolicyDraft,
} from "./delivery-policy-model.js";

type PendingSave = Readonly<{
  confirmRef: string;
  summary: DeliveryPolicyConfirmationSummary;
}>;

export type DeliveryPolicyPanelProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

export function DeliveryPolicyPanel({
  session,
  authClient,
  commandClient,
  queryClient,
}: DeliveryPolicyPanelProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<DeliveryPolicyDraft>(EMPTY_DELIVERY_POLICY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const loadGeneration = useRef(0);
  const commandGeneration = useRef(0);
  const sessionScope = [
    session.session.session_id,
    session.session.session_version,
    session.session.org_id,
    session.session.store_id,
    session.session.staff_id,
    session.session.permission_version,
  ].join(":");
  const currentSessionScope = useRef(sessionScope);
  currentSessionScope.current = sessionScope;
  const featureEnabled = session.features.delivery_enabled === true;

  const reload = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const scope = sessionScope;
    setLoading(true);
    try {
      const result = await queryClient.execute<unknown>("delivery.policy.get", {});
      if (generation !== loadGeneration.current || scope !== currentSessionScope.current) {
        return false;
      }
      if (!result.ok) {
        setLoaded(false);
        toast.push(result.error.message ?? result.error.code, "error");
        return false;
      }
      const next = readDeliveryPolicy(result.data);
      if (next === null) {
        setLoaded(false);
        toast.push("取送策略返回格式无效", "error");
        return false;
      }
      setDraft(next);
      setLoaded(true);
      return true;
    } catch {
      if (generation !== loadGeneration.current || scope !== currentSessionScope.current) {
        return false;
      }
      setLoaded(false);
      toast.push("无法读取取送策略，请检查服务连接", "error");
      return false;
    } finally {
      if (generation === loadGeneration.current && scope === currentSessionScope.current) {
        setLoading(false);
      }
    }
  }, [queryClient, sessionScope, toast]);

  useEffect(() => {
    loadGeneration.current += 1;
    commandGeneration.current += 1;
    setDraft(EMPTY_DELIVERY_POLICY_DRAFT);
    setLoaded(false);
    setPending(null);
    setBusy(false);
    void reload();
    return () => {
      loadGeneration.current += 1;
      commandGeneration.current += 1;
    };
  }, [reload]);

  const finish = useCallback(
    async (confirmRef: string) => {
      const generation = commandGeneration.current + 1;
      commandGeneration.current = generation;
      const scope = sessionScope;
      setBusy(true);
      try {
        const result = await commandClient.execute("delivery.policy.set", {}, { confirmRef });
        if (generation !== commandGeneration.current || scope !== currentSessionScope.current)
          return;
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return;
        }
        setPending(null);
        const refreshed = await reload();
        toast.push(
          refreshed ? "取送策略已保存" : "取送策略已保存，但当前界面仍需重新读取",
          refreshed ? "success" : "error",
        );
      } catch {
        if (generation !== commandGeneration.current || scope !== currentSessionScope.current)
          return;
        toast.push("无法完成取送策略复核，请检查服务连接", "error");
      } finally {
        if (generation === commandGeneration.current && scope === currentSessionScope.current) {
          setBusy(false);
        }
      }
    },
    [commandClient, reload, sessionScope, toast],
  );

  const save = useCallback(async () => {
    const built = buildDeliveryPolicyInput(draft);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    const generation = commandGeneration.current + 1;
    commandGeneration.current = generation;
    const scope = sessionScope;
    setBusy(true);
    try {
      const result = await commandClient.execute("delivery.policy.set", built.body);
      if (generation !== commandGeneration.current || scope !== currentSessionScope.current) return;
      if (result.ok) {
        const refreshed = await reload();
        toast.push(
          refreshed ? "取送策略已保存" : "取送策略已保存，但当前界面仍需重新读取",
          refreshed ? "success" : "error",
        );
        return;
      }
      if (isStepUpRequired(result)) {
        const summary = DeliveryPolicyConfirmationSummarySchema.safeParse(
          result.error.detail.summary,
        );
        if (!summary.success) {
          toast.push("服务端未返回可核对的完整取送策略，请勿复核", "error");
          setPending(null);
          return;
        }
        setPending(
          Object.freeze({
            confirmRef: result.error.detail.confirm_ref,
            summary: Object.freeze({
              ...summary.data,
              service_areas: Object.freeze(
                summary.data.service_areas.map((area) => Object.freeze({ ...area })),
              ),
              weekly_windows: Object.freeze(
                summary.data.weekly_windows.map((window) => Object.freeze({ ...window })),
              ),
            }),
          }),
        );
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } catch {
      if (generation !== commandGeneration.current || scope !== currentSessionScope.current) return;
      toast.push("无法保存取送策略，请检查服务连接", "error");
    } finally {
      if (generation === commandGeneration.current && scope === currentSessionScope.current) {
        setBusy(false);
      }
    }
  }, [commandClient, draft, reload, sessionScope, toast]);

  const changeDraft = useCallback((next: DeliveryPolicyDraft) => {
    loadGeneration.current += 1;
    setDraft(next);
  }, []);

  return (
    <section
      className="ld-delivery-policy lg-card"
      aria-label="门店取送策略"
      data-testid="delivery-policy-settings"
    >
      <h2 className="ld-shell-main__title">门店取送策略</h2>
      <p className="ld-shell-main__hint">
        配置本店服务区域、每周时段、运费和可预约规则；保存需另一位店长现场复核。
      </p>
      <p className="ld-delivery-policy__boundary">
        此处不维护顾客地址，不创建预约；取送功能开关仍由部署与门店能力配置独立控制。
      </p>
      <DeliveryPolicyEditor
        draft={draft}
        busy={busy || loading || pending !== null}
        loaded={loaded}
        onChange={changeDraft}
        onSave={() => void save()}
        onReload={() => void reload()}
      />
      <p className="ld-shell-main__hint" role="status">
        当前策略版本 {draft.version}；区域 {draft.service_areas.length} 个，时段{" "}
        {draft.weekly_windows.length} 个。
      </p>
      <DeliveryAvailabilityQuoteForm
        key={sessionScope}
        queryClient={queryClient}
        featureEnabled={featureEnabled}
      />
      <StepUpConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        authClient={authClient}
        confirmRef={pending?.confirmRef ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="修改门店取送策略"
        summary={
          pending === null ? undefined : (
            <DeliveryPolicyConfirmationSummaryView summary={pending.summary} />
          )
        }
        onApproved={() => {
          const ref = pending?.confirmRef;
          if (ref !== undefined) void finish(ref);
        }}
      />
    </section>
  );
}
