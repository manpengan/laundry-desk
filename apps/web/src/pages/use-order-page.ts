import { useCallback, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import { useRequestLifetime } from "./use-request-lifetime.js";

export type OrderPage = Readonly<{
  orders: readonly OrderListRowView[];
  total: number;
  offset: number;
  limit: number;
}>;
export function parseOrderPage(value: unknown): OrderPage | null {
  const result = unwrapQueryResult(value);
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = result as Readonly<Record<string, unknown>>;
  const orders = parseOrderListRows(record);
  const { total, offset, limit } = record;
  if (
    orders === null ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    orders.length > limit ||
    total < orders.length ||
    (orders.length > 0 && offset + orders.length > total)
  )
    return null;
  return Object.freeze({ orders, total, offset, limit });
}

export function useOrderPage(queryClient: QueryPort) {
  const requests = useRequestLifetime(queryClient);
  const [page, setPage] = useState<OrderPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Readonly<Record<string, unknown>>>({});
  const pending = useRef<Readonly<Record<string, unknown>>>({ offset: 0, limit: 50 });
  const load = useCallback(
    async (body: Readonly<Record<string, unknown>>) => {
      const token = requests.begin();
      if (token === null) return;
      pending.current = body;
      setBusy(true);
      try {
        const result = await queryClient.execute<unknown>("order.list", body);
        if (!requests.isCurrent(token)) return;
        if (!result.ok) {
          setError("订单列表加载失败，请检查连接后重试。");
          return;
        }
        const next = parseOrderPage(result.data);
        if (next === null || next.offset !== body.offset || next.limit !== body.limit) {
          setError("订单分页返回格式无效，请重试。");
          return;
        }
        setPage(next);
        setApplied(body);
        setError(null);
      } catch {
        if (requests.isCurrent(token)) setError("订单列表加载失败，请检查连接后重试。");
      } finally {
        if (requests.isCurrent(token)) setBusy(false);
      }
    },
    [queryClient, requests],
  );
  const retry = useCallback(() => load(pending.current), [load]);
  return { page, busy, error, applied, load, retry };
}
