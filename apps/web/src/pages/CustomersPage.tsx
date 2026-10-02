/**
 * 客户档案 — customer.search + customer.upsert + 详情/历史订单 (M2).
 */

import { Button, EmptyState, Icon, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { PrintJobView } from "../shell/print-jobs.js";
import { CustomerWorkspace } from "./CustomerWorkspace.js";
import { loadCustomerHistory } from "./customer-history.js";
import {
  parseCustomerDetail,
  parseCustomerRows,
  type CustomerRowView,
  unwrapQueryResult,
} from "./customer-model.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";
import type { OrderListRowView } from "./OrdersList.js";
import { useScanFocus } from "./use-scan-focus.js";

export {
  formatCustomerUpdatedAt,
  parseCustomerRows,
  type CustomerRowView,
  unwrapQueryResult,
} from "./customer-model.js";

export type CustomersPageProps = {
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  photoPort?: PhotoPort;
  /** Skip auto-search on mount (tests). */
  autoLoad?: boolean;
  /** Prefill selected customer (SSR detail shell / tests). */
  initialSelected?: CustomerRowView;
  /** Prefill history rows for SSR when initialSelected is set. */
  initialOrders?: readonly OrderListRowView[];
  initialPrintJobs?: readonly PrintJobView[];
  /** Navigate to pickup with order id prefilled. */
  onOpenPickup?: (orderId: string) => void;
  /** Open with this search (工作台 / 命令面板) and select a known customer. */
  initialQuery?: string;
  initialCustomerId?: string;
};

const PHONE_RE = /^1[3-9]\d{9}$/u;

export function CustomersPage({
  queryClient,
  commandClient,
  authClient,
  session,
  photoPort,
  autoLoad = true,
  initialSelected,
  initialOrders,
  initialPrintJobs,
  onOpenPickup,
  initialQuery,
  initialCustomerId,
}: CustomersPageProps) {
  const toast = useToast();
  const [queryText, setQueryText] = useState(() => initialQuery ?? "");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly CustomerRowView[]>([]);
  const [selected, setSelected] = useState<CustomerRowView | null>(() => initialSelected ?? null);
  const [orderRows, setOrderRows] = useState<readonly OrderListRowView[]>(
    () => initialOrders ?? Object.freeze([]),
  );
  const [printJobs, setPrintJobs] = useState<readonly PrintJobView[] | null>(
    () => initialPrintJobs ?? null,
  );
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const searchRef = useRef<() => Promise<readonly CustomerRowView[]>>(async () => []);
  const pendingSelectRef = useRef<string | undefined>(initialCustomerId);
  const pageRef = useRef<HTMLElement | null>(null);
  useScanFocus(pageRef, 'input[name="customer-query"]');

  // The search field never locks (it keeps the scanner's caret); the latest
  // request wins so a slow earlier search cannot overwrite newer results.
  const searchSeq = useRef(0);
  const search = useCallback(async (): Promise<readonly CustomerRowView[]> => {
    const seq = ++searchSeq.current;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { limit: 20 };
      const q = queryText.trim();
      if (q.length > 0) body.query = q;
      const res = await queryClient.execute<unknown>("customer.search", body);
      if (seq !== searchSeq.current) return [];
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setRows([]);
        return [];
      }
      const parsed = parseCustomerRows(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("客户列表无法解析", "error");
        setRows([]);
        return [];
      }
      setRows(parsed);
      return parsed;
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }, [queryClient, queryText, toast]);

  searchRef.current = search;

  useEffect(() => {
    if (!autoLoad) return;
    void searchRef.current().then((found) => {
      const wanted = pendingSelectRef.current;
      pendingSelectRef.current = undefined;
      const match =
        wanted === undefined
          ? found.length === 1 && initialQuery !== undefined
            ? found[0]
            : undefined
          : found.find((row) => row.customer_id === wanted);
      if (match !== undefined) void selectRef.current(match);
    });
  }, [autoLoad, initialQuery]);

  useEffect(() => {
    if (selected === null) {
      setOrdersBusy(false);
      return;
    }
    let cancelled = false;
    setOrdersBusy(true);
    void loadCustomerHistory(queryClient, selected.phone)
      .then((history) => {
        if (cancelled) return;
        if (history === null) {
          toast.push("客户历史暂时无法加载", "error");
          setOrderRows([]);
          setPrintJobs(null);
          return;
        }
        setOrderRows(history.orders);
        setPrintJobs(history.printJobs);
      })
      .finally(() => {
        if (!cancelled) setOrdersBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient, selected, toast]);

  const selectCustomer = useCallback(
    async (row: CustomerRowView) => {
      setBusy(true);
      setOrderRows([]);
      setPrintJobs(null);
      setOrdersBusy(true);
      setDetailOrderId(null);
      try {
        const result = await queryClient.execute<unknown>("customer.get", {
          customer_id: row.customer_id,
        });
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          setOrdersBusy(false);
          return;
        }
        const detail = parseCustomerDetail(unwrapQueryResult(result.data));
        if (detail === null) {
          toast.push("客户详情无法解析", "error");
          setOrdersBusy(false);
          return;
        }
        setSelected(detail);
      } finally {
        setBusy(false);
      }
    },
    [queryClient, toast],
  );

  const selectRef = useRef(selectCustomer);
  selectRef.current = selectCustomer;

  const closeDetail = useCallback(() => {
    setSelected(null);
    setOrderRows([]);
    setPrintJobs(null);
    setDetailOrderId(null);
  }, []);

  const onUpsert = useCallback(async () => {
    const p = phone.trim();
    if (!PHONE_RE.test(p)) {
      toast.push("请输入 11 位手机号（1[3-9]…）", "error");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { phone: p };
      const n = name.trim();
      if (n.length > 0) body.name = n;
      const res = await commandClient.execute<unknown>("customer.upsert", body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      toast.push("客户已保存", "success");
      setPhone("");
      setName("");
      await search();
    } finally {
      setBusy(false);
    }
  }, [commandClient, name, phone, search, toast]);

  return (
    <main ref={pageRef} className="ld-shell-main ld-customers" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">客户</h1>
      <p className="ld-shell-main__hint">
        按手机号、姓名或会员标识查找；选中客户后在右侧查看档案、历史订单与会员信息。
      </p>

      <div className="ld-customers-search">
        <Input
          name="customer-query"
          label="搜索"
          placeholder="手机号、姓名或会员标识，按 Enter 搜索"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          autoComplete="off"
          data-testid="customers-search-input"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void search();
            }
          }}
        />
        <div className="ld-customers-search__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void search()}
            disabled={busy}
            data-testid="customers-search-btn"
          >
            <Icon name="search" size={16} />
            {busy ? "加载中…" : "搜索"}
          </Button>
        </div>
      </div>

      <form
        className="ld-customers-form"
        aria-label="快速建档"
        onSubmit={(event) => {
          event.preventDefault();
          void onUpsert();
        }}
      >
        <span className="ld-customers-form__title">
          <Icon name="plus" size={16} />
          快速建档
        </span>
        <Input
          name="customer-phone"
          label="手机号"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={busy}
          data-testid="customers-phone-input"
        />
        <Input
          name="customer-name"
          label="姓名"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          data-testid="customers-name-input"
        />
        <div className="ld-customers-form__actions">
          <Button
            variant="secondary"
            type="submit"
            disabled={busy}
            data-testid="customers-upsert-btn"
          >
            保存客户
          </Button>
        </div>
      </form>

      <div className={selected === null ? "ld-customers-layout" : "ld-customers-layout is-open"}>
        <ul className="ld-customers-list" data-testid="customers-list" aria-label="客户列表">
          {rows.length === 0 ? (
            <li className="ld-customers-list__empty">暂无匹配客户</li>
          ) : (
            rows.map((row) => (
              <li key={row.customer_id} className="ld-customers-list__row">
                <button
                  type="button"
                  className="ld-customers-list__btn"
                  onClick={() => void selectCustomer(row)}
                  data-testid="customers-row"
                  aria-pressed={selected?.customer_id === row.customer_id}
                >
                  <span className="ld-customers-list__avatar" aria-hidden="true">
                    {(row.name ?? "客").slice(0, 1)}
                  </span>
                  <span className="ld-customers-list__main">
                    <span className="ld-customers-list__name">{row.name ?? "未命名客户"}</span>
                    <span className="ld-customers-list__phone ld-customers-phone-internal">
                      {row.phone}
                    </span>
                  </span>
                  <Icon name="chevronRight" size={16} />
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="ld-customers-workspace">
          {selected === null ? (
            <EmptyState
              icon={<Icon name="customers" size={26} />}
              title="选择一位客户"
              description="选中左侧客户后，这里显示档案、历史订单、会员与取送信息。"
            />
          ) : (
            <CustomerWorkspace
              customer={selected}
              orders={orderRows}
              printJobs={printJobs}
              ordersBusy={ordersBusy}
              queryClient={queryClient}
              commandClient={commandClient}
              {...(authClient === undefined ? {} : { authClient })}
              {...(session === undefined ? {} : { session })}
              toast={toast}
              onClose={closeDetail}
              onOpenOrder={setDetailOrderId}
              {...(onOpenPickup === undefined ? {} : { onOpenPickup })}
              onReselect={() => void selectCustomer(selected)}
              onRemoved={() => {
                closeDetail();
                void search();
              }}
            />
          )}
        </div>
      </div>
      <OrderDetailDrawer
        open={detailOrderId !== null}
        orderId={detailOrderId}
        queryClient={queryClient}
        commandClient={commandClient}
        memberEnabled={session?.features.member_enabled === true}
        {...(authClient === undefined ? {} : { authClient })}
        {...(session === undefined ? {} : { session })}
        {...(photoPort === undefined ? {} : { photoPort })}
        onClose={() => setDetailOrderId(null)}
        {...(onOpenPickup === undefined
          ? {}
          : {
              onPickup: (orderId: string) => {
                setDetailOrderId(null);
                onOpenPickup(orderId);
              },
            })}
      />
    </main>
  );
}
