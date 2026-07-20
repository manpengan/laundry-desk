import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import type { OrderSearchResultDto } from "@shared/index";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { formatCurrency } from "@renderer/lib/utils";

export default function Pickup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OrderSearchResultDto[]>([]);
  const [message, setMessage] = useState("输入信息开始查询订单");
  const [messageVariant, setMessageVariant] = useState<
    "info" | "success" | "warning" | "error"
  >("info");
  const [loading, setLoading] = useState(false);
  const [confirmingOrderId, setConfirmingOrderId] = useState<number | null>(
    null,
  );
  const navigate = useNavigate();

  const searchOrders = async (
    value: string,
    options?: { preserveMessage?: boolean },
  ): Promise<void> => {
    if (!value) {
      setMessageVariant("warning");
      setMessage("请输入取件码、手机号、单号或姓名");
      setResults([]);
      return;
    }

    setLoading(true);
    const response = await window.api.orders.searchForPickup(value);
    setLoading(false);

    if (!response.ok) {
      setMessageVariant("error");
      setMessage(response.error.message);
      setResults([]);
      return;
    }

    setResults(response.data);
    setConfirmingOrderId(null);
    if (!options?.preserveMessage) {
      setMessageVariant("info");
      setMessage(response.data.length === 0 ? "未找到待取订单" : "");
    }
  };

  const handlePickup = async (order: OrderSearchResultDto): Promise<void> => {
    const balance = order.totalAmount - order.paidAmount;
    if (confirmingOrderId !== order.id) {
      setConfirmingOrderId(order.id);
      setMessageVariant("warning");
      setMessage(
        balance > 0
          ? `订单 ${order.orderNo} 尚有 ${formatCurrency(balance)} 欠款，再点一次“确认取件”会一并补收后完成取件。`
          : `订单 ${order.orderNo} 已准备交接，再点一次“确认取件”完成操作。`,
      );
      return;
    }

    const response = await window.api.orders.pickup({
      orderId: order.id,
      paidAmount: balance,
    });
    if (!response.ok) {
      setMessageVariant("error");
      setMessage(response.error.message);
      return;
    }

    setConfirmingOrderId(null);
    setMessageVariant("success");
    setMessage(`订单 ${order.orderNo} 取件成功`);
    await searchOrders(query.trim(), { preserveMessage: true });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
          Pickup
        </p>
        <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
          取件查询
        </h2>
      </div>

      <div className="lg-card lg-spec rounded-[20px] p-4">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-3.5 h-4 w-4 text-[var(--lg-ink3)]" />
            <Input
              placeholder="输入 4 位取件码 / 手机号 / 订单号 / 姓名"
              className="pl-10"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void searchOrders(query.trim());
              }}
            />
          </div>
          <Button
            onClick={() => void searchOrders(query.trim())}
            disabled={loading}
          >
            {loading ? "查询中..." : "查询"}
          </Button>
        </div>
      </div>

      {message &&
        (results.length > 0 ? (
          <Notice variant={messageVariant}>{message}</Notice>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-[13.5px] text-[var(--lg-ink3)]">
            <p>{message}</p>
          </div>
        ))}

      <div className="grid gap-3">
        {results.map((order) => {
          const balance = order.totalAmount - order.paidAmount;
          return (
            <div
              key={order.id}
              className="lg-card lg-spec flex flex-wrap items-center gap-4 rounded-[20px] p-4"
            >
              <span
                className="lg-inset grid h-[58px] w-[86px] flex-none place-items-center rounded-[14px] text-[24px] font-bold tracking-[0.12em] text-[var(--lg-accent)]"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {order.pickupCode}
              </span>
              <button
                className="min-w-0 flex-1 text-left"
                type="button"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="text-[15px] font-bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {order.orderNo}
                  </span>
                  {balance > 0 ? (
                    <span className="lg-pill late">
                      待补款 {formatCurrency(balance)}
                    </span>
                  ) : (
                    <span className="lg-pill ok">已结清</span>
                  )}
                </div>
                <div className="mt-1 truncate text-[13px] text-[var(--lg-ink2)]">
                  {order.customerName} · {order.customerPhone} · 应收{" "}
                  {formatCurrency(order.totalAmount)}
                </div>
              </button>
              <Button onClick={() => void handlePickup(order)}>
                {confirmingOrderId === order.id ? "再次确认取件" : "确认取件"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
