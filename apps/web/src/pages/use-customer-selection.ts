import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import type { PrintJobView } from "../shell/print-jobs.js";
import { loadCustomerHistory } from "./customer-history.js";
import { parseCustomerDetail, unwrapQueryResult, type CustomerRowView } from "./customer-model.js";
import type { OrderListRowView } from "./OrdersList.js";
import { useRequestLifetime } from "./use-request-lifetime.js";

type Options = Readonly<{
  queryClient: QueryPort;
  initialSelected?: CustomerRowView | undefined;
  initialOrders?: readonly OrderListRowView[] | undefined;
  initialPrintJobs?: readonly PrintJobView[] | undefined;
  notify: (message: string, tone: "error") => void;
}>;

export function useCustomerSelection({
  queryClient,
  initialSelected,
  initialOrders,
  initialPrintJobs,
  notify,
}: Options) {
  const details = useRequestLifetime(queryClient);
  const history = useRequestLifetime(queryClient);
  const requested = useRef<CustomerRowView | null>(null);
  const [selected, setSelected] = useState<CustomerRowView | null>(initialSelected ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<readonly OrderListRowView[]>(initialOrders ?? []);
  const [printJobs, setPrintJobs] = useState<readonly PrintJobView[] | null>(
    initialPrintJobs ?? null,
  );
  const [ordersBusy, setOrdersBusy] = useState(false);

  const [ordersPage, setOrdersPage] = useState({
    total: initialOrders?.length ?? 0,
    offset: 0,
    limit: 20,
  });
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const requestedOffset = useRef(0);
  const loadOrders = useCallback(
    async (offset: number) => {
      if (selected === null) return;
      const token = history.begin();
      if (token === null) return;
      requestedOffset.current = offset;
      setOrdersBusy(true);
      try {
        const result = await loadCustomerHistory(
          queryClient,
          selected.phone,
          offset,
          selected.customer_id,
        );
        if (!history.isCurrent(token)) return;
        if (result === null) {
          setOrdersError("客户历史暂时无法加载，请重试。");
          notify("客户历史暂时无法加载", "error");
          return;
        }
        setOrders(result.orders);
        setPrintJobs(result.printJobs);
        setOrdersPage({ total: result.total, offset: result.offset, limit: result.limit });
        setOrdersError(null);
      } finally {
        if (history.isCurrent(token)) setOrdersBusy(false);
      }
    },
    [history, notify, queryClient, selected],
  );
  useEffect(() => {
    void loadOrders(0);
    return () => history.invalidate();
  }, [history, loadOrders]);
  const retryOrders = useCallback(() => loadOrders(requestedOffset.current), [loadOrders]);

  const select = useCallback(
    async (row: CustomerRowView): Promise<void> => {
      const token = details.begin();
      if (token === null) return;
      history.invalidate();
      requested.current = row;
      setSelected(null);
      setOrders([]);
      setOrdersError(null);
      setOrdersPage({ total: 0, offset: 0, limit: 20 });
      setPrintJobs(null);
      setOrdersBusy(false);
      setLoading(true);
      setError(null);
      try {
        const response = await queryClient.execute<unknown>("customer.get", {
          customer_id: row.customer_id,
        });
        if (!details.isCurrent(token)) return;
        if (!response.ok) {
          setError("客户详情加载失败，请重试。");
          return;
        }
        const customer = parseCustomerDetail(unwrapQueryResult(response.data));
        if (customer === null || customer.customer_id !== row.customer_id) {
          setError("客户详情返回格式无效，请重试。");
          return;
        }
        setSelected(customer);
      } catch {
        if (details.isCurrent(token)) setError("客户详情加载失败，请重试。");
      } finally {
        if (details.isCurrent(token)) setLoading(false);
      }
    },
    [details, history, queryClient],
  );
  const close = useCallback(() => {
    details.invalidate();
    history.invalidate();
    requested.current = null;
    setSelected(null);
    setOrders([]);
    setOrdersError(null);
    setOrdersPage({ total: 0, offset: 0, limit: 20 });
    setPrintJobs(null);
    setOrdersBusy(false);
    setLoading(false);
    setError(null);
  }, [details, history]);
  const retry = useCallback(async () => {
    if (requested.current !== null) await select(requested.current);
  }, [select]);
  return {
    selected,
    loading,
    error,
    orders,
    printJobs,
    ordersBusy,
    ordersError,
    ordersPage,
    loadOrders,
    retryOrders,
    select,
    close,
    retry,
  };
}
