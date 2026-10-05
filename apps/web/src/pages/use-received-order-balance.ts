import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { parseOrderGetResult, unwrapCommandResult } from "./order-form.js";
import type { ReceiveWorkspace } from "./receive-workspace.js";

/** An unmounted QR can be paid elsewhere. Always recheck before offering another payment. */
export function useReceivedOrderBalance(store: ReceiveWorkspace, query: QueryPort | undefined) {
  const orderId = store.getSnapshot().result?.order_id;
  const generation = useRef(0);
  const [checked, setChecked] = useState<string>();
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setChecked(undefined);
    setMessage("");
    if (!orderId || !query) return;
    try {
      const response = await query.execute<unknown>("order.get", { order_id: orderId });
      if (request !== generation.current) return;
      const order = response.ok ? parseOrderGetResult(unwrapCommandResult(response.data)) : null;
      const current = store.getSnapshot();
      if (current.phase !== "complete" || current.result?.order_id !== orderId) return;
      if (!order || order.order_id !== orderId) throw new Error("unconfirmed");
      store.patch({
        result: Object.freeze({
          ...current.result,
          payable_cents: order.payable_cents,
          paid_cents: order.paid_cents,
          balance_cents: order.balance_cents,
        }),
      });
      setChecked(orderId);
    } catch {
      if (request === generation.current)
        setMessage("最新收款金额尚未核对，已暂停再次收款。请连接服务后重试。");
    }
  }, [orderId, query, store]);
  useEffect(() => {
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  return { refresh, message, checking: query !== undefined && checked !== orderId };
}
