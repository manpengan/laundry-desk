import { Button, Input, useToast } from "@laundry/ui";
import {
  MarketingCampaignGetResultSchema,
  MarketingCouponIssuePreviewResultSchema,
  MarketingCouponIssueResultSchema,
  MemberBenefitCatalogResultSchema,
  type MarketingCampaign,
  type MarketingCouponIssueConfirmationSummary,
  type MarketingCouponIssuePreview,
} from "@laundry/contracts";
import { useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "../pages/customer-model.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { MarketingCouponIssueConfirmationDetails } from "./MarketingCouponConfirmationDetails.js";
import {
  createMarketingCommandEpoch,
  marketingCommandEpochMatches,
  marketingCouponPreviewMatches,
  marketingIssueAuthorityKey,
  marketingIssueSummaryMatches,
} from "./marketing-coupon-preview.js";

type Option = Readonly<{ id: string; label: string }>;
type PendingIssue = Readonly<{
  ref: string;
  summary: MarketingCouponIssueConfirmationSummary;
}>;

export type OwnerMarketingCouponsProps = Readonly<{
  campaign: MarketingCampaign | null;
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  onChanged: () => Promise<void>;
}>;

export function OwnerMarketingCoupons({
  campaign,
  session,
  authClient,
  commandClient,
  queryClient,
  onChanged,
}: OwnerMarketingCouponsProps) {
  const toast = useToast();
  const [snapshots, setSnapshots] = useState<readonly Option[]>([]);
  const [coupons, setCoupons] = useState<readonly Option[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [couponId, setCouponId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<MarketingCouponIssuePreview | null>(null);
  const [pending, setPending] = useState<PendingIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const previewRequest = useRef(0);
  const issueGeneration = useRef(0);
  const selectedAuthority =
    campaign === null || snapshotId === "" || couponId === ""
      ? null
      : Object.freeze({
          campaign_id: campaign.campaign_id,
          expected_version: campaign.version,
          snapshot_id: snapshotId,
          coupon_definition_id: couponId,
        });
  const issueAuthorityKey = marketingIssueAuthorityKey(selectedAuthority, reason.trim());
  const issueAuthorityKeyRef = useRef(issueAuthorityKey);
  issueAuthorityKeyRef.current = issueAuthorityKey;

  useEffect(() => {
    let active = true;
    previewRequest.current += 1;
    issueGeneration.current += 1;
    setPreview(null);
    setSnapshots([]);
    setCoupons([]);
    setSnapshotId("");
    setCouponId("");
    setPending(null);
    if (campaign === null) {
      setSnapshots([]);
      return () => {
        active = false;
      };
    }
    void Promise.all([
      queryClient.execute<unknown>("marketing.campaign.get", {
        campaign_id: campaign.campaign_id,
      }),
      queryClient.execute<unknown>("member.benefit_catalog.get", { include_retired: false }),
    ])
      .then(([campaignResponse, catalogResponse]) => {
        if (!active) return;
        if (!campaignResponse.ok || !catalogResponse.ok) {
          toast.push("无法读取冻结受众或优惠券定义", "error");
          return;
        }
        const detail = MarketingCampaignGetResultSchema.safeParse(
          unwrapQueryResult(campaignResponse.data),
        );
        const catalog = MemberBenefitCatalogResultSchema.safeParse(
          unwrapQueryResult(catalogResponse.data),
        );
        if (!detail.success || !catalog.success) {
          toast.push("营销发券基础数据格式无效", "error");
          return;
        }
        const nextSnapshots = detail.data.snapshots.map((snapshot) =>
          Object.freeze({
            id: snapshot.snapshot_id,
            label: `${snapshot.recipient_count} 人 · ${new Date(snapshot.created_at).toLocaleString()}`,
          }),
        );
        const nextCoupons = catalog.data.coupon_types.map((coupon) =>
          Object.freeze({
            id: coupon.definition_id,
            label: `${coupon.name} · ¥${(coupon.discount_cents / 100).toFixed(2)}`,
          }),
        );
        previewRequest.current += 1;
        issueGeneration.current += 1;
        setPreview(null);
        setPending(null);
        setSnapshots(Object.freeze(nextSnapshots));
        setCoupons(Object.freeze(nextCoupons));
        setSnapshotId((current) =>
          nextSnapshots.some((option) => option.id === current)
            ? current
            : (nextSnapshots[0]?.id ?? ""),
        );
        setCouponId((current) =>
          nextCoupons.some((option) => option.id === current)
            ? current
            : (nextCoupons[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (active) toast.push("无法读取冻结受众或优惠券定义", "error");
      });
    return () => {
      active = false;
    };
  }, [campaign, queryClient, toast]);

  const authority = () => selectedAuthority;

  const invalidateIssue = () => {
    issueGeneration.current += 1;
    setPending(null);
  };

  const runPreview = async () => {
    const input = authority();
    if (input === null || busy) return;
    const requestId = ++previewRequest.current;
    setPreview(null);
    setBusy(true);
    try {
      const response = await queryClient.execute<unknown>(
        "marketing.campaign.coupons.preview",
        input,
      );
      if (requestId !== previewRequest.current) return;
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = MarketingCouponIssuePreviewResultSchema.safeParse(
        unwrapQueryResult(response.data),
      );
      if (!parsed.success) throw new Error("invalid coupon preview");
      setPreview(Object.freeze(parsed.data.preview));
    } catch {
      if (requestId === previewRequest.current) {
        toast.push("资格或冻结受众已变化，请重新冻结后再试", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const applyIssue = async (value: unknown) => {
    const parsed = MarketingCouponIssueResultSchema.safeParse(unwrapQueryResult(value));
    if (!parsed.success) throw new Error("invalid coupon issue result");
    toast.push(
      `${parsed.data.batch.replayed ? "已确认" : "已发放"} ${parsed.data.batch.granted_count} 张优惠券`,
      "success",
    );
    setPending(null);
    setPreview(null);
    await onChanged();
  };

  const issue = async () => {
    const input = authority();
    const normalizedReason = reason.trim();
    if (input === null || preview === null || normalizedReason === "" || busy) return;
    if (!marketingCouponPreviewMatches(preview, input)) {
      setPreview(null);
      toast.push("选择已变化，请重新计算资格", "error");
      return;
    }
    const request = createMarketingCommandEpoch(
      ++issueGeneration.current,
      marketingIssueAuthorityKey(input, normalizedReason),
    );
    setBusy(true);
    try {
      const response = await commandClient.execute<unknown>("marketing.campaign.coupons.issue", {
        ...input,
        reason: normalizedReason,
      });
      if (
        !marketingCommandEpochMatches(
          request,
          issueGeneration.current,
          issueAuthorityKeyRef.current,
        )
      ) {
        return;
      }
      if (response.ok) {
        await applyIssue(response.data);
        return;
      }
      const confirmRef = response.error.detail?.confirm_ref;
      const summary = response.error.detail?.summary;
      if (
        response.error.code === "POLICY_STEP_UP_REQUIRED" &&
        typeof confirmRef === "string" &&
        summary?.kind === "marketing_coupon_issue"
      ) {
        if (!marketingIssueSummaryMatches(summary, input, normalizedReason)) {
          toast.push("服务端确认内容与当前选择不一致，请重新发起", "error");
          return;
        }
        setPending(
          Object.freeze({
            ref: confirmRef,
            summary,
          }),
        );
        return;
      }
      toast.push(response.error.message ?? response.error.code, "error");
    } catch {
      toast.push("批量发券失败，未写入部分批次", "error");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (pending === null || busy) return;
    setBusy(true);
    try {
      const response = await commandClient.execute<unknown>(
        "marketing.campaign.coupons.issue",
        {},
        { confirmRef: pending.ref },
      );
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      await applyIssue(response.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ld-owner-management lg-card" aria-label="活动批量发券">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">R4 · 服务端资格 · 预算最坏值占用</span>
          <h2>批量发券</h2>
          <p>只使用已冻结受众；发放前会重新计算名单，非有效会员自动排除。</p>
        </div>
      </header>
      {campaign === null ? (
        <p>请先选择一个活动。</p>
      ) : (
        <>
          <div className="ld-owner-management__form">
            <label className="ld-marketing-field">
              冻结受众
              <select
                disabled={busy}
                value={snapshotId}
                onChange={(event) => {
                  previewRequest.current += 1;
                  invalidateIssue();
                  setSnapshotId(event.target.value);
                  setPreview(null);
                }}
              >
                <option value="">请选择</option>
                {snapshots.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ld-marketing-field">
              优惠券
              <select
                disabled={busy}
                value={couponId}
                onChange={(event) => {
                  previewRequest.current += 1;
                  invalidateIssue();
                  setCouponId(event.target.value);
                  setPreview(null);
                }}
              >
                <option value="">请选择</option>
                {coupons.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              name="marketing-coupon-reason"
              label="发放原因"
              maxLength={256}
              disabled={busy}
              value={reason}
              onChange={(event) => {
                invalidateIssue();
                setReason(event.target.value);
              }}
            />
          </div>
          <div className="ld-marketing-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void runPreview()}
            >
              计算资格
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy || preview === null || reason.trim() === ""}
              onClick={() => void issue()}
            >
              发放并复核
            </Button>
          </div>
          {preview === null ? null : (
            <p className="ld-marketing-preview" role="status">
              冻结 {preview.audience_recipient_count} 人；可发 {preview.eligible_recipient_count}{" "}
              人， 排除 {preview.ineligible_recipient_count} 人；占用 ¥
              {(preview.budget_required_cents / 100).toFixed(2)}， 剩余 ¥
              {(preview.budget_remaining_cents / 100).toFixed(2)}。
            </p>
          )}
        </>
      )}
      <StepUpConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        authClient={authClient}
        confirmRef={pending?.ref ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="活动批量发券"
        summary={
          pending === null ? undefined : (
            <MarketingCouponIssueConfirmationDetails summary={pending.summary} />
          )
        }
        onApproved={() => void resume()}
      />
    </section>
  );
}
