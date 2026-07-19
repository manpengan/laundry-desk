import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ChevronLeft, Printer, CheckCircle2 } from "lucide-react";
import type { OrderWithDetailsDto } from "@shared/index";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { formatCurrency } from "@renderer/lib/utils";
import { orderStatus, serviceTypeLabel } from "../components/home/homeData";

interface RouteNoticeState {
  notice?: {
    variant: "success" | "warning" | "error" | "info";
    message: string;
  };
}

const mediaUrl = (filePath: string): string =>
  `${window.laundryEnv?.mediaBase ?? "media://"}${filePath}`;

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [order, setOrder] = useState<OrderWithDetailsDto | null>(null);
  const [notice, setNotice] = useState<RouteNoticeState["notice"]>(
    (location.state as RouteNoticeState | null)?.notice,
  );
  const [pickupPending, setPickupPending] = useState(false);

  useEffect(() => {
    if (id) {
      void window.api.orders.findById(parseInt(id, 10)).then((res) => {
        if (res.ok) setOrder(res.data ?? null);
      });
    }
  }, [id]);

  const preparePickup = (): void => {
    if (!order || order.status === "picked_up") return;
    setNotice({
      variant: "warning",
      message:
        order.totalAmount > order.paidAmount
          ? `该订单还有 ${formatCurrency(order.totalAmount - order.paidAmount)} 欠款，点击“确认完成取件”后会一并补收。`
          : "请确认衣物已交接，再点击“确认完成取件”。",
    });
    setPickupPending(true);
  };

  const confirmPickup = async (): Promise<void> => {
    if (!order) return;
    const balance = order.totalAmount - order.paidAmount;
    try {
      const res = await window.api.orders.pickup({
        orderId: order.id,
        paidAmount: balance > 0 ? balance : 0,
      });
      if (res.ok) {
        setNotice({ variant: "success", message: "取件成功" });
        setPickupPending(false);
        try {
          await window.api.printer.printPickup(order.id);
        } catch (printErr) {
          console.error("取件小票打印失败:", printErr);
        }
        const updated = await window.api.orders.findById(order.id);
        if (updated.ok) setOrder(updated.data ?? null);
      } else {
        setNotice({ variant: "error", message: res.error.message });
      }
    } catch (error) {
      setNotice({
        variant: "error",
        message:
          error instanceof Error ? error.message : "取件失败，请稍后重试",
      });
      setPickupPending(false);
    }
  };

  if (!order) {
    return (
      <div className="p-20 text-center text-[13.5px] text-[var(--lg-ink3)]">
        正在加载订单详情...
      </div>
    );
  }

  const st = orderStatus(order);
  const balance = order.totalAmount - order.paidAmount;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/orders")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
            Order
          </p>
          <h2 className="mt-0.5 flex items-center gap-2.5 text-[20px] font-bold leading-none tracking-[-0.02em]">
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {order.orderNo}
            </span>
            <span className={`lg-pill ${st.cls}`}>{st.text}</span>
          </h2>
        </div>
      </div>

      {notice && <Notice variant={notice.variant}>{notice.message}</Notice>}

      <div className="grid items-start gap-3.5 md:grid-cols-3">
        <div className="space-y-3.5 md:order-2 md:col-span-1">
          <div
            className="lg-spec overflow-hidden rounded-[22px] p-6 text-center text-white"
            style={{
              background:
                "linear-gradient(160deg, var(--lg-accent2), var(--lg-accent))",
              boxShadow:
                "0 18px 44px var(--lg-accent-soft), inset 0 1px 0 rgba(255,255,255,0.4)",
            }}
          >
            <div className="text-[11px] font-bold uppercase tracking-[0.3em] opacity-80">
              取件码
            </div>
            <div
              className="mt-1 text-[52px] font-black leading-none tracking-[0.08em]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {order.pickupCode}
            </div>
            <div
              className="mt-2 text-[11px] font-semibold tracking-[0.14em] opacity-70"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {order.orderNo}
            </div>
          </div>

          <div className="lg-card lg-spec rounded-[20px] p-4">
            <h3 className="text-[13px] font-semibold text-[var(--lg-ink2)]">
              客户信息
            </h3>
            <div className="mt-2.5 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--lg-accent-soft)] text-[14px] font-bold text-[var(--lg-accent)]">
                {order.customer.name.slice(0, 1)}
              </span>
              <div>
                <div className="text-[15px] font-bold">
                  {order.customer.name}
                </div>
                <div
                  className="text-[12.5px] text-[var(--lg-ink2)]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {order.customer.phone}
                </div>
              </div>
            </div>
          </div>

          <div className="lg-card lg-spec rounded-[20px] p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--lg-ink2)]">
                付款详情
              </h3>
              {balance > 0 ? (
                <span className="lg-pill late">欠款</span>
              ) : (
                <span className="lg-pill ok">已结清</span>
              )}
            </div>
            <div
              className="mt-3 space-y-2 text-[13.5px]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              <div className="flex justify-between">
                <span className="text-[var(--lg-ink2)]">应付总计</span>
                <span className="font-bold">
                  {formatCurrency(order.totalAmount)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--lg-ink2)]">实付金额</span>
                <span className="font-bold text-[var(--lg-ok-ink)]">
                  {formatCurrency(order.paidAmount)}
                </span>
              </div>
              {balance > 0 && (
                <div
                  className="flex justify-between border-t pt-2"
                  style={{ borderColor: "var(--lg-hair)" }}
                >
                  <span className="text-[var(--lg-ink2)]">剩余欠款</span>
                  <span className="font-bold text-[var(--lg-late-ink)]">
                    {formatCurrency(balance)}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2.5">
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                void window.api.printer
                  .printReceipt(order.id)
                  .catch((err) => console.error("登记单打印失败:", err));
              }}
            >
              <Printer className="mr-2 h-4 w-4" /> 打印票据
            </Button>
            {pickupPending && order.status !== "picked_up" && (
              <div className="space-y-2">
                <Button className="w-full" onClick={() => void confirmPickup()}>
                  <CheckCircle2 className="mr-2 h-4 w-4" /> 确认完成取件
                </Button>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => {
                    setPickupPending(false);
                    setNotice(undefined);
                  }}
                >
                  取消
                </Button>
              </div>
            )}
            <Button
              className="w-full"
              disabled={order.status === "picked_up"}
              onClick={preparePickup}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {order.status === "picked_up"
                ? "已取件"
                : pickupPending
                  ? "等待最终确认"
                  : "开始取件"}
            </Button>
          </div>
        </div>

        <div className="space-y-3.5 md:order-1 md:col-span-2">
          <div className="lg-card lg-spec overflow-hidden rounded-[22px]">
            <div
              className="flex items-center justify-between border-b px-5 py-4"
              style={{ borderColor: "var(--lg-hair)" }}
            >
              <div>
                <h3 className="text-[15px] font-semibold">物品明细</h3>
                <p className="mt-0.5 text-[11.5px] text-[var(--lg-ink3)]">
                  共 {order.items.length} 项
                </p>
              </div>
              <div
                className="text-[20px] font-bold text-[var(--lg-accent)]"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatCurrency(order.totalAmount)}
              </div>
            </div>
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-[11.5px] font-bold uppercase tracking-wide text-[var(--lg-ink3)]">
                  <th className="px-5 py-2.5 text-left">物品</th>
                  <th className="px-5 py-2.5 text-left">服务</th>
                  <th className="px-5 py-2.5 text-right">数量</th>
                  <th className="px-5 py-2.5 text-right">小计</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr
                    key={item.id}
                    className="transition-colors hover:bg-[var(--lg-leaf-hover)]"
                  >
                    <td className="px-5 py-3 font-semibold">{item.itemType}</td>
                    <td className="px-5 py-3 text-[var(--lg-ink2)]">
                      {serviceTypeLabel[item.serviceType] ?? item.serviceType}
                    </td>
                    <td
                      className="px-5 py-3 text-right"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      × {item.quantity}
                    </td>
                    <td
                      className="px-5 py-3 text-right font-bold"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatCurrency(item.subtotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {order.notes && (
            <div className="lg-card lg-spec rounded-[20px] p-4">
              <h3 className="text-[13px] font-semibold text-[var(--lg-ink2)]">
                备注
              </h3>
              <p className="mt-2 text-[13.5px]">{order.notes}</p>
            </div>
          )}

          {order.photos && order.photos.length > 0 && (
            <div className="lg-card lg-spec rounded-[20px] p-4">
              <h3 className="text-[13px] font-semibold text-[var(--lg-ink2)]">
                衣物留样照片
              </h3>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {order.photos.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    className="lg-inset group relative aspect-square overflow-hidden rounded-[14px]"
                    onClick={() => window.open(mediaUrl(photo.filePath))}
                  >
                    <img
                      src={mediaUrl(photo.filePath)}
                      className="h-full w-full cursor-pointer object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
