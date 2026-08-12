import { Button, Dialog } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { CustomerRowView } from "./customer-model.js";
import { MemberBenefitAssets } from "./MemberBenefitAssets.js";
import { MemberMembershipPoints } from "./MemberMembershipPoints.js";
import {
  parseMemberBenefitCatalog,
  parseMemberBenefitMutation,
  parseMemberBenefits,
  type MemberBenefitCatalogView,
  type MemberBenefitsView,
} from "./member-benefits-model.js";
import type { RunBenefitMutation } from "./member-benefits-ui-types.js";

export type MemberBenefitsPanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  session?: SessionView;
  toast: Readonly<{ push: (message: string, kind: "success" | "error") => void }>;
}>;

type PendingMutation = Readonly<{
  command: string;
  confirmRef: string;
  title: string;
  success: string;
}>;

export function MemberBenefitsPanel({
  customer,
  queryClient,
  commandClient,
  session,
  toast,
}: MemberBenefitsPanelProps) {
  const [benefits, setBenefits] = useState<MemberBenefitsView | null>(null);
  const [catalog, setCatalog] = useState<MemberBenefitCatalogView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [benefitResult, catalogResult] = await Promise.all([
        queryClient.execute<unknown>("member.benefits.get", {
          customer_id: customer.customer_id,
          include_expired: true,
        }),
        queryClient.execute<unknown>("member.benefit_catalog.get", {}),
      ]);
      if (!benefitResult.ok) {
        setBenefits(null);
        setNoAccount(benefitResult.error.code === "VALIDATION_FAILED");
        setFailed(benefitResult.error.code !== "VALIDATION_FAILED");
        if (benefitResult.error.code !== "VALIDATION_FAILED") {
          toast.push(benefitResult.error.message ?? benefitResult.error.code, "error");
        }
        setLoaded(true);
        return;
      }
      if (!catalogResult.ok) {
        setFailed(true);
        toast.push(catalogResult.error.message ?? catalogResult.error.code, "error");
        setLoaded(true);
        return;
      }
      const parsedBenefits = parseMemberBenefits(benefitResult.data);
      const parsedCatalog = parseMemberBenefitCatalog(catalogResult.data);
      if (
        parsedBenefits === null ||
        parsedCatalog === null ||
        parsedBenefits.customer_id !== customer.customer_id
      ) {
        setFailed(true);
        toast.push("会员权益响应无法解析", "error");
        setLoaded(true);
        return;
      }
      setBenefits(parsedBenefits);
      setCatalog(parsedCatalog);
      setFailed(false);
      setNoAccount(false);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [customer.customer_id, queryClient, toast]);

  useEffect(() => {
    setBenefits(null);
    setCatalog(null);
    setLoaded(false);
    setFailed(false);
    setNoAccount(false);
    void load();
  }, [load]);

  const applyMutation = useCallback(
    (raw: unknown, success: string): boolean => {
      const parsed = parseMemberBenefitMutation(raw);
      if (parsed === null || parsed.benefits.customer_id !== customer.customer_id) {
        toast.push("会员权益变更响应无法解析，请刷新确认", "error");
        return false;
      }
      setBenefits(parsed.benefits);
      toast.push(success, "success");
      return true;
    },
    [customer.customer_id, toast],
  );

  const runMutation: RunBenefitMutation = useCallback(
    async (command, body, title, success) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (result.ok) {
          applyMutation(result.data, success);
          return;
        }
        if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
          setPending(
            Object.freeze({
              command,
              confirmRef: result.error.detail.confirm_ref,
              title,
              success,
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [applyMutation, commandClient, toast],
  );

  const confirm = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        pending.command,
        {},
        { confirmRef: pending.confirmRef },
      );
      if (!result.ok) {
        setPending(null);
        toast.push(result.error.message ?? result.error.code, "error");
        await load();
        return;
      }
      if (applyMutation(result.data, pending.success)) setPending(null);
    } finally {
      setBusy(false);
    }
  }, [applyMutation, commandClient, load, pending, toast]);

  if (!loaded) {
    return (
      <section className="ld-member-benefits">
        <h3>会员权益</h3>
        <p>读取中…</p>
      </section>
    );
  }
  if (noAccount) {
    return (
      <section className="ld-member-benefits">
        <h3>会员权益</h3>
        <p>尚未开通会员账户。请先在上方开通储值账户，再重试读取权益。</p>
        <Button type="button" onClick={() => void load()} disabled={busy}>
          重新读取
        </Button>
      </section>
    );
  }
  if (failed || benefits === null || catalog === null) {
    return (
      <section className="ld-member-benefits">
        <h3>会员权益</h3>
        <p role="alert">权益信息读取失败或格式无效。</p>
        <Button type="button" onClick={() => void load()} disabled={busy}>
          重试
        </Button>
      </section>
    );
  }

  const mutable = benefits.account_status === "active";
  return (
    <section className="ld-member-benefits" data-testid="member-benefits-panel">
      <div className="ld-member-panel__heading">
        <h3>会员权益</h3>
        <span
          className={`ld-member-panel__status ld-member-panel__status--${benefits.account_status}`}
        >
          {benefits.account_status === "active"
            ? "账户正常"
            : benefits.account_status === "frozen"
              ? "账户冻结"
              : "账户关闭"}
        </span>
      </div>
      {!mutable ? (
        <p className="ld-member-panel__hint">
          冻结或关闭账户不能变更、授予或消费权益；储值本金和赠款不会因权益到期而失效。
        </p>
      ) : null}
      <MemberMembershipPoints
        key={`membership:${benefits.membership.version}`}
        benefits={benefits}
        catalog={catalog}
        isAdmin={session?.role === "admin"}
        busy={busy}
        mutable={mutable}
        toast={toast}
        runMutation={runMutation}
      />
      <MemberBenefitAssets
        benefits={benefits}
        catalog={catalog}
        isAdmin={session?.role === "admin"}
        busy={busy}
        mutable={mutable}
        toast={toast}
        runMutation={runMutation}
      />
      <Dialog
        open={pending !== null}
        title={pending?.title ?? "确认会员权益变更"}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" type="button" disabled={busy} onClick={() => setPending(null)}>
              取消
            </Button>
            <Button variant="primary" type="button" disabled={busy} onClick={() => void confirm()}>
              确认执行
            </Button>
          </>
        }
      >
        <p>服务端已冻结本次参数；确认后将追加可审计记录，历史权益不会被重写。</p>
      </Dialog>
    </section>
  );
}
