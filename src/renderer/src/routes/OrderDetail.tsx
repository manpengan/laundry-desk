import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { formatCurrency, cn } from "@renderer/lib/utils";
import { ChevronLeft, Printer, CheckCircle2 } from "lucide-react";
import type { OrderWithDetailsDto } from "@shared/index";

interface RouteNoticeState {
  notice?: {
    variant: "success" | "warning" | "error" | "info";
    message: string;
  };
}

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
      window.api.orders.findById(parseInt(id, 10)).then((res) => {
        if (res.ok) setOrder(res.data ?? null);
      });
    }
  }, [id]);

  const preparePickup = () => {
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

  const confirmPickup = async () => {
    if (!order) return;

    const balance = order.totalAmount - order.paidAmount;
    const paidExtra = balance > 0 ? balance : 0;

    try {
      const res = await window.api.orders.pickup({
        orderId: order.id,
        paidAmount: paidExtra,
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
      const message =
        error instanceof Error ? error.message : "取件失败，请稍后重试";
      setNotice({ variant: "error", message });
      setPickupPending(false);
    }
  };

  if (!order)
    return (
      <div className="p-20 text-center text-slate-500">正在加载订单详情...</div>
    );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/orders")}>
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-2xl font-bold">订单详情: {order.orderNo}</h2>
      </div>

      {notice && <Notice variant={notice.variant}>{notice.message}</Notice>}

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <Card className="border-none shadow-sm overflow-hidden">
            <CardHeader className="bg-slate-50 border-b border-slate-100 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg">物品明细</CardTitle>
                <p className="text-xs text-slate-500 uppercase mt-1">
                  共 {order.items.length} 件物品
                </p>
              </div>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrency(order.totalAmount)}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                    <th className="px-6 py-3 text-left font-medium">物品</th>
                    <th className="px-6 py-3 text-left font-medium">服务</th>
                    <th className="px-6 py-3 text-right font-medium">数量</th>
                    <th className="px-6 py-3 text-right font-medium">小计</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {order.items.map((item: any) => (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium">{item.itemType}</td>
                      <td className="px-6 py-4 text-slate-500 uppercase text-[10px] tracking-wider">
                        {item.serviceType}
                      </td>
                      <td className="px-6 py-4 text-right">
                        x {item.quantity}
                      </td>
                      <td className="px-6 py-4 text-right font-bold text-slate-900">
                        {formatCurrency(item.subtotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">备注</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">
                {order.notes || "无备注信息"}
              </p>
            </CardContent>
          </Card>

          {order.photos && order.photos.length > 0 && (
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">衣物留样照片</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {order.photos.map((photo: any) => (
                    <div
                      key={photo.id}
                      className="relative aspect-square rounded-xl overflow-hidden border border-slate-100 bg-slate-50 group"
                    >
                      <img
                        src={`media://${photo.filePath}`}
                        className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform duration-200"
                        onClick={() => window.open(`media://${photo.filePath}`)}
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card className="border-none shadow-sm bg-blue-600 text-white overflow-hidden">
            <CardContent className="p-6 text-center space-y-2">
              <div className="text-xs text-blue-200 uppercase tracking-widest font-bold">
                取件码
              </div>
              <div className="text-5xl font-black tracking-tighter">
                {order.pickupCode}
              </div>
              <div className="pt-2 text-[10px] text-blue-100 uppercase tracking-widest font-bold opacity-70">
                {order.orderNo}
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base text-slate-500">
                客户信息
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="font-bold text-lg">{order.customer.name}</div>
                <div className="text-sm text-slate-500">
                  {order.customer.phone}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base text-slate-500">
                付款详情
              </CardTitle>
              <div
                className={cn(
                  "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                  order.totalAmount > order.paidAmount
                    ? "bg-red-50 text-red-600"
                    : "bg-green-50 text-green-600",
                )}
              >
                {order.totalAmount > order.paidAmount ? "欠款" : "已结清"}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">应付总计</span>
                <span className="font-bold">
                  {formatCurrency(order.totalAmount)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">实付金额</span>
                <span className="font-bold text-green-600">
                  {formatCurrency(order.paidAmount)}
                </span>
              </div>
              {order.totalAmount > order.paidAmount && (
                <div className="flex justify-between text-sm pt-2 border-t border-slate-100">
                  <span className="text-slate-500">剩余欠款</span>
                  <span className="font-bold text-red-600">
                    {formatCurrency(order.totalAmount - order.paidAmount)}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Button
              className="w-full"
              variant="outline"
              onClick={async () => {
                try {
                  await window.api.printer.printReceipt(order.id);
                } catch (err) {
                  console.error("登记单打印失败:", err);
                }
              }}
            >
              <Printer className="w-4 h-4 mr-2" /> 打印票据
            </Button>
            {pickupPending && order.status !== "picked_up" && (
              <div className="space-y-2">
                <Button
                  className="w-full bg-green-600 hover:bg-green-700 text-white shadow-sm"
                  onClick={() => void confirmPickup()}
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  确认完成取件
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
              className="w-full bg-green-600 hover:bg-green-700 text-white shadow-sm"
              disabled={order.status === "picked_up"}
              onClick={preparePickup}
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {order.status === "picked_up"
                ? "已取件"
                : pickupPending
                  ? "等待最终确认"
                  : "开始取件"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
