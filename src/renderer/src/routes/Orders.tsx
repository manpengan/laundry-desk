import { useEffect, useState } from "react";
import { Card, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { formatCurrency, cn } from "@renderer/lib/utils";
import { useNavigate } from "react-router-dom";

const STATUS_MAP = {
  pending: { label: "待处理", color: "bg-yellow-50 text-yellow-600" },
  ready: { label: "可取件", color: "bg-blue-50 text-blue-600" },
  picked_up: { label: "已取件", color: "bg-green-50 text-green-600" },
  cancelled: { label: "已取消", color: "bg-red-50 text-red-600" },
};

export default function Orders() {
  const [orders, setOrders] = useState<any[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    window.api.orders.findAll().then((res: any) => {
      if (res.ok) setOrders(res.data);
    });
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">订单列表</h2>
        <Button onClick={() => navigate("/receive")}>新收件</Button>
      </div>

      <div className="grid gap-4">
        {orders.map((order) => (
          <Card
            key={order.id}
            className="border-none shadow-sm hover:ring-1 hover:ring-blue-100 transition-all cursor-pointer"
            onClick={() => navigate(`/orders/${order.id}`)}
          >
            <CardContent className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center font-bold text-blue-600">
                  {order.pickupCode}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-lg">{order.orderNo}</span>
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                        STATUS_MAP[order.status as keyof typeof STATUS_MAP]
                          .color,
                      )}
                    >
                      {
                        STATUS_MAP[order.status as keyof typeof STATUS_MAP]
                          .label
                      }
                    </span>
                  </div>
                  <div className="text-sm text-slate-500 mt-1">
                    {order.customer.name} · {order.customer.phone}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="font-bold text-lg text-blue-600">
                  {formatCurrency(order.totalAmount)}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {new Date(order.receiveDate).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {orders.length === 0 && (
          <div className="py-20 text-center text-slate-400">暂无订单记录</div>
        )}
      </div>
    </div>
  );
}
