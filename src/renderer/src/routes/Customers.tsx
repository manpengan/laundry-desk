import { useEffect, useState } from "react";
import type { CustomerDto } from "@shared/index";
import { Input } from "../components/ui/Input";
import { formatCurrency } from "@renderer/lib/utils";

export default function Customers() {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerDto[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void window.api.customers.findAll({ query }).then((response) => {
        if (response.ok) setCustomers(response.data);
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
          Customers
        </p>
        <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
          客户管理
        </h2>
        <p className="mt-2 text-[13px] text-[var(--lg-ink2)]">
          按手机号自动去重，累计订单与消费额。
        </p>
      </div>
      <Input
        placeholder="搜索姓名或手机号"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="grid gap-2.5">
        {customers.map((customer) => (
          <div
            key={customer.id}
            className="lg-card lg-spec flex items-center justify-between gap-4 rounded-[18px] p-4"
          >
            <div className="flex min-w-0 items-center gap-3.5">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[var(--lg-accent-soft)] text-[14px] font-bold text-[var(--lg-accent)]">
                {customer.name.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-bold">
                  {customer.name}
                </div>
                <div
                  className="text-[12.5px] text-[var(--lg-ink2)]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {customer.phone}
                </div>
              </div>
            </div>
            <div
              className="flex-none text-right"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              <div className="text-[12.5px] text-[var(--lg-ink2)]">
                {customer.totalOrders} 单
              </div>
              <div className="text-[15px] font-bold text-[var(--lg-accent)]">
                {formatCurrency(customer.totalSpent)}
              </div>
            </div>
          </div>
        ))}
        {customers.length === 0 && (
          <div className="py-16 text-center text-[13.5px] text-[var(--lg-ink3)]">
            暂无客户记录
          </div>
        )}
      </div>
    </div>
  );
}
