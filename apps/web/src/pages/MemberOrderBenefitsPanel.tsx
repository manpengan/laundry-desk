import { Button, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildCouponConsumeBody,
  buildPointsEarnBody,
  isCouponEligible,
  parseMemberBenefitMutation,
  parseMemberBenefits,
  type MemberBenefitsView,
} from "./member-benefits-model.js";
import type { OrderGetResult } from "./order-form.js";

export type MemberOrderBenefitsPanelProps = Readonly<{
  order: OrderGetResult;
  queryClient: QueryPort;
  commandClient: CommandPort;
  onOrderReload: () => void | Promise<void>;
}>;

export function MemberOrderBenefitsPanel({
  order,
  queryClient,
  commandClient,
  onOrderReload,
}: MemberOrderBenefitsPanelProps) {
  const toast = useToast();
  const [benefits, setBenefits] = useState<MemberBenefitsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (order.customer_id === null) {
      setBenefits(null);
      setFailed(false);
      setLoaded(true);
      return;
    }
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("member.benefits.get", {
        customer_id: order.customer_id,
      });
      if (!result.ok) {
        setBenefits(null);
        setFailed(result.error.code !== "VALIDATION_FAILED");
        setLoaded(true);
        return;
      }
      const parsed = parseMemberBenefits(result.data);
      if (parsed === null || parsed.customer_id !== order.customer_id) {
        setBenefits(null);
        setFailed(true);
        setLoaded(true);
        return;
      }
      setBenefits(parsed);
      setFailed(false);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [order.customer_id, queryClient]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load, order.discount_cents, order.paid_cents, order.status]);

  const eligibleCoupons = useMemo(
    () => benefits?.coupons.filter((coupon) => isCouponEligible(coupon, order)) ?? [],
    [benefits, order],
  );

  const applyMutation = useCallback(
    (raw: unknown, success: string): boolean => {
      const parsed = parseMemberBenefitMutation(raw);
      if (parsed === null || parsed.benefits.customer_id !== order.customer_id) {
        toast.push("会员权益响应无法解析，请刷新订单确认", "error");
        return false;
      }
      setBenefits(parsed.benefits);
      toast.push(success, "success");
      return true;
    },
    [order.customer_id, toast],
  );

  const earnPoints = useCallback(async () => {
    if (benefits === null) return;
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        "member.points.earn",
        buildPointsEarnBody(benefits.account_id, order.order_id),
      );
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      applyMutation(result.data, "订单积分已按服务端规则入账");
    } finally {
      setBusy(false);
    }
  }, [applyMutation, benefits, commandClient, order.order_id, toast]);

  const consumeCoupon = useCallback(
    async (assetId: string) => {
      const body = buildCouponConsumeBody(assetId, order.order_id);
      if (body === null) {
        toast.push("优惠券或订单标识无效", "error");
        return;
      }
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>("member.asset.consume", body);
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return;
        }
        if (applyMutation(result.data, "优惠券已核销，订单金额由服务端重算")) {
          await onOrderReload();
        }
      } finally {
        setBusy(false);
      }
    },
    [applyMutation, commandClient, onOrderReload, order.order_id, toast],
  );

  if (!loaded)
    return (
      <section className="ld-order-benefits">
        <h3>会员权益</h3>
        <p>读取中…</p>
      </section>
    );
  if (failed)
    return (
      <section className="ld-order-benefits">
        <h3>会员权益</h3>
        <p role="alert">权益读取失败。</p>
        <Button type="button" disabled={busy} onClick={() => void load()}>
          重试
        </Button>
      </section>
    );
  if (benefits === null)
    return (
      <section className="ld-order-benefits">
        <h3>会员权益</h3>
        <p>{order.customer_id === null ? "此订单未关联顾客。" : "关联顾客尚未开通会员账户。"}</p>
      </section>
    );

  const canEarn = order.status === "closed" && order.balance_cents === 0;
  const couponOrder =
    order.status === "open" && order.paid_cents === 0 && order.discount_cents === 0;
  return (
    <section className="ld-order-benefits" data-testid="order-member-benefits">
      <h3>会员权益</h3>
      <p>当前可用积分 {benefits.points.available_points} 分；积分与券金额均由服务端计算。</p>
      {canEarn ? (
        <Button
          variant="secondary"
          type="button"
          disabled={busy || benefits.account_status !== "active"}
          onClick={() => void earnPoints()}
          data-testid="order-points-earn"
        >
          领取订单积分
        </Button>
      ) : (
        <p className="ld-member-panel__hint">订单关闭且结清后才能领取积分。</p>
      )}
      {couponOrder ? (
        eligibleCoupons.length === 0 ? (
          <p className="ld-member-panel__hint">暂无满足最低金额且未到期的优惠券。</p>
        ) : (
          <ul className="ld-benefit-assets">
            {eligibleCoupons.map((coupon) => (
              <li key={coupon.asset_id}>
                <span>
                  {coupon.name}：减 <MoneyText fen={coupon.discount_cents} />
                  ，满 <MoneyText fen={coupon.min_order_cents} /> 可用，到期 {coupon.expires_on}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || benefits.account_status !== "active"}
                  onClick={() => void consumeCoupon(coupon.asset_id)}
                  data-testid="order-coupon-consume"
                >
                  核销
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="ld-member-panel__hint">优惠券仅可用于未收款、无既有折扣的进行中订单。</p>
      )}
    </section>
  );
}
