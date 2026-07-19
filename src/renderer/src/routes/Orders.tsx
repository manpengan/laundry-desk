import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { OrderWithDetailsDto } from "@shared/index";
import { Button } from "../components/ui/Button";
import { formatCurrency } from "@renderer/lib/utils";
import { itemSummary, orderStatus } from "../components/home/homeData";

export default function Orders() {
  const [orders, setOrders] = useState<OrderWithDetailsDto[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    void window.api.orders.findAll({ limit: 100 }).then((res) => {
      if (res.ok) setOrders(res.data);
    });
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
            Orders
          </p>
          <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
            订单列表
          </h2>
        </div>
        <Button onClick={() => navigate("/receive")}>新收件</Button>
      </div>

      <div className="grid gap-2.5">
        {orders.map((order) => {
          const st = orderStatus(order);
          return (
            <button
              key={order.id}
              type="button"
              onClick={() => navigate(`/orders/${order.id}`)}
              className="lg-card lg-spec lg-pressable flex items-center gap-4 rounded-[18px] p-3.5 text-left"
            >
              <span
                className="lg-inset grid h-12 w-16 flex-none place-items-center rounded-[12px] text-[17px] font-bold tracking-[0.1em] text-[var(--lg-accent)]"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {order.pickupCode}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <span
                    className="text-[14.5px] font-bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {order.orderNo}
                  </span>
                  <span className={`lg-pill ${st.cls}`}>{st.text}</span>
                </div>
                <div className="mt-1 truncate text-[12.5px] text-[var(--lg-ink2)]">
                  {order.customer?.name} · {order.customer?.phone}
                  <span className="hidden sm:inline">
                    {" "}
                    · {itemSummary(order)}
                  </span>
                </div>
              </div>
              <div className="flex-none text-right">
                <div
                  className="text-[15px] font-bold text-[var(--lg-accent)]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatCurrency(order.totalAmount)}
                </div>
                <div className="mt-0.5 text-[11.5px] text-[var(--lg-ink3)]">
                  {order.receiveDate
                    ? new Date(order.receiveDate).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </div>
              </div>
            </button>
          );
        })}
        {orders.length === 0 && (
          <div className="py-16 text-center text-[13.5px] text-[var(--lg-ink3)]">
            暂无订单记录
          </div>
        )}
      </div>
    </div>
  );
}
