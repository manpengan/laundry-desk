import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import type { OrderSearchResultDto } from "@shared/index";
import { Card, CardContent } from "../components/ui/Card";
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
  ) => {
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

  const handleSearch = async () => {
    const value = query.trim();
    await searchOrders(value);
  };

  const handlePickup = async (order: OrderSearchResultDto) => {
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
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">取件查询</h2>

      <Card className="border-none shadow-sm">
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
              <Input
                placeholder="输入 4 位取件码 / 手机号 / 订单号 / 姓名"
                className="pl-10"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSearch();
                }}
              />
            </div>
            <Button size="lg" onClick={handleSearch} disabled={loading}>
              {loading ? "查询中..." : "查询"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {message &&
        (results.length > 0 ? (
          <Notice variant={messageVariant}>{message}</Notice>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <p>{message}</p>
          </div>
        ))}

      <div className="grid gap-4">
        {results.map((order) => {
          const balance = order.totalAmount - order.paidAmount;
          return (
            <Card key={order.id} className="border-none shadow-sm">
              <CardContent className="p-5 flex items-center justify-between gap-4">
                <button
                  className="text-left flex-1"
                  type="button"
                  onClick={() => navigate(`/orders/${order.id}`)}
                >
                  <div className="font-bold text-lg">{order.orderNo}</div>
                  <div className="text-sm text-slate-500 mt-1">
                    {order.customerName} · {order.customerPhone} · 取件码{" "}
                    {order.pickupCode}
                  </div>
                  <div className="text-sm mt-2">
                    {balance > 0 ? (
                      <span className="text-red-600">
                        待补款 {formatCurrency(balance)}
                      </span>
                    ) : (
                      <span className="text-green-600">已结清</span>
                    )}
                  </div>
                </button>
                <Button onClick={() => void handlePickup(order)}>
                  {confirmingOrderId === order.id ? "再次确认取件" : "确认取件"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
