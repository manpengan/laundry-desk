import { useEffect, useState } from "react";
import type { CustomerDto } from "@shared/index";
import { Card, CardContent } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { formatCurrency } from "@renderer/lib/utils";

export default function Customers() {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerDto[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.api.customers.findAll({ query }).then((response) => {
        if (response.ok) setCustomers(response.data);
      });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">客户管理</h2>
        <p className="text-slate-500 mt-2">
          按手机号自动去重，累计订单和消费额。
        </p>
      </div>
      <Input
        placeholder="搜索姓名或手机号"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="grid gap-4">
        {customers.map((customer) => (
          <Card key={customer.id} className="border-none shadow-sm">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <div className="font-bold text-lg">{customer.name}</div>
                <div className="text-sm text-slate-500">{customer.phone}</div>
              </div>
              <div className="text-right text-sm">
                <div>{customer.totalOrders} 单</div>
                <div className="font-bold text-blue-600">
                  {formatCurrency(customer.totalSpent)}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {customers.length === 0 && (
          <div className="py-20 text-center text-slate-400">暂无客户记录</div>
        )}
      </div>
    </div>
  );
}
