import {
  DeliveryAvailabilityQuoteInputSchema,
  type DeliveryAvailabilityQuote,
} from "@laundry/contracts";
import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useRef, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import { epochFromLocalDateTime, readDeliveryQuote } from "./delivery-policy-model.js";

export type DeliveryAvailabilityQuoteFormProps = Readonly<{
  queryClient: QueryPort;
  featureEnabled: boolean;
}>;

const REASON_LABELS: Readonly<Record<DeliveryAvailabilityQuote["reason"], string>> = Object.freeze({
  available: "策略允许提出预约请求",
  delivery_disabled: "本店取送功能未启用",
  policy_not_configured: "尚未配置取送策略",
  appointments_paused: "当前暂停接受预约",
  service_area_unavailable: "服务区域不可用",
  outside_booking_horizon: "不在可预约提前范围内",
  outside_service_window: "不在门店服务时段内",
  slot_misaligned: "时间未对齐预约格",
});

export function DeliveryAvailabilityQuoteForm({
  queryClient,
  featureEnabled,
}: DeliveryAvailabilityQuoteFormProps) {
  const toast = useToast();
  const [direction, setDirection] = useState<"pickup" | "return">("pickup");
  const [areaCode, setAreaCode] = useState("");
  const [dateTime, setDateTime] = useState("");
  const [quote, setQuote] = useState<DeliveryAvailabilityQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const changeInput = useCallback(<T,>(setValue: (value: T) => void, value: T) => {
    generation.current += 1;
    setQuote(null);
    setValue(value);
  }, []);

  const runQuote = useCallback(async () => {
    const requestedStartAt = epochFromLocalDateTime(dateTime);
    const parsed = DeliveryAvailabilityQuoteInputSchema.safeParse({
      direction,
      service_area_code: areaCode.trim(),
      requested_start_at: requestedStartAt,
    });
    if (!parsed.success) {
      setQuote(null);
      toast.push("请填写有效区域编码和整分钟预约时间", "error");
      return;
    }
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("delivery.availability.quote", parsed.data);
      if (requestGeneration !== generation.current) return;
      if (!result.ok) {
        setQuote(null);
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const next = readDeliveryQuote(result.data);
      if (next === null) {
        setQuote(null);
        toast.push("取送报价返回格式无效", "error");
        return;
      }
      setQuote(next);
    } catch {
      if (requestGeneration !== generation.current) return;
      setQuote(null);
      toast.push("无法读取取送报价，请检查服务连接", "error");
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  }, [areaCode, dateTime, direction, queryClient, toast]);

  return (
    <div className="ld-delivery-policy__quote" data-testid="delivery-policy-quote">
      <h3 className="ld-delivery-policy__heading">策略报价</h3>
      <p className="ld-shell-main__hint">
        仅校验区域、运费、提前期与时段；不查询已占名额、不保留容量，也不创建预约。
      </p>
      {!featureEnabled ? (
        <p className="ld-delivery-policy__notice" role="status">
          本店取送功能当前关闭；策略可以预先维护，但所有报价都会返回不可预约。
        </p>
      ) : null}
      <div className="ld-delivery-policy__quote-fields">
        <label className="ld-delivery-policy__field">
          <span>方向</span>
          <select
            value={direction}
            onChange={(event) =>
              changeInput(setDirection, event.target.value === "return" ? "return" : "pickup")
            }
            disabled={busy}
          >
            <option value="pickup">上门取件</option>
            <option value="return">送回顾客</option>
          </select>
        </label>
        <Input
          label="服务区域编码"
          value={areaCode}
          onChange={(event) => changeInput(setAreaCode, event.target.value)}
          disabled={busy}
        />
        <Input
          label="预约时间（按本设备时区输入）"
          type="datetime-local"
          value={dateTime}
          onChange={(event) => changeInput(setDateTime, event.target.value)}
          disabled={busy}
        />
        <Button variant="secondary" type="button" onClick={() => void runQuote()} disabled={busy}>
          {busy ? "校验中…" : "获取策略报价"}
        </Button>
      </div>
      {quote === null ? null : (
        <div className="ld-delivery-policy__quote-result" role="status">
          <strong>{REASON_LABELS[quote.reason]}</strong>
          <span>门店时区：{quote.timezone}</span>
          <span>策略版本：{quote.policy_version}</span>
          {quote.fee_cents === null ? null : (
            <span>
              运费：
              <MoneyText fen={quote.fee_cents} />
            </span>
          )}
          <span>容量：未检查（本报价不会占用名额）</span>
        </div>
      )}
    </div>
  );
}
