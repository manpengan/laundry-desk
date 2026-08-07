/**
 * 客户档案 — customer.search + customer.upsert + 详情/历史订单 (M2).
 */

import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { PrintJobView } from "../shell/print-jobs.js";
import { CustomerDetail } from "./CustomerDetail.js";
import { CustomerGovernancePanel } from "./CustomerGovernancePanel.js";
import { MemberBalancePanel } from "./MemberBalancePanel.js";
import { CustomerPrivacyPanel } from "./CustomerPrivacyPanel.js";
import { loadCustomerHistory } from "./customer-history.js";
import {
  parseCustomerDetail,
  parseCustomerRows,
  type CustomerRowView,
  unwrapQueryResult,
} from "./customer-model.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";
import type { OrderListRowView } from "./OrdersList.js";

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
}: CustomersPageProps) {
  const toast = useToast();
  const [queryText, setQueryText] = useState("");
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
  const searchRef = useRef<() => Promise<void>>(async () => undefined);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { limit: 20 };
      const q = queryText.trim();
      if (q.length > 0) body.query = q;
      const res = await queryClient.execute<unknown>("customer.search", body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setRows([]);
        return;
      }
      const parsed = parseCustomerRows(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("客户列表无法解析", "error");
        setRows([]);
        return;
      }
      setRows(parsed);
    } finally {
      setBusy(false);
    }
  }, [queryClient, queryText, toast]);

  searchRef.current = search;

  useEffect(() => {
    if (!autoLoad) return;
    void searchRef.current();
  }, [autoLoad]);

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
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">客户</h1>
      <p className="ld-shell-main__hint">
        组织级客户档案：按手机号前缀或姓名搜索；点击行查看详情与历史订单。
      </p>

      <div className="ld-customers-search">
        <Input
          name="customer-query"
          label="搜索"
          placeholder="手机号前缀或姓名"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          disabled={busy}
          data-testid="customers-search-input"
        />
        <div className="ld-customers-search__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void search()}
            disabled={busy}
            data-testid="customers-search-btn"
          >
            {busy ? "加载中…" : "搜索"}
          </Button>
        </div>
      </div>

      <form
        className="ld-customers-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onUpsert();
        }}
      >
        <Input
          name="customer-phone"
          label="手机号"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={busy}
          data-testid="customers-phone-input"
        />
        <Input
          name="customer-name"
          label="姓名"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          data-testid="customers-name-input"
        />
        <div className="ld-customers-form__actions">
          <Button
            variant="primary"
            type="submit"
            disabled={busy}
            data-testid="customers-upsert-btn"
          >
            保存客户
          </Button>
        </div>
      </form>

      <ul className="ld-customers-list" data-testid="customers-list">
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
                <div className="ld-customers-list__main">
                  <span className="ld-customers-list__phone ld-customers-phone-internal">
                    {row.phone}
                  </span>
                  <span className="ld-customers-list__name">{row.name ?? "—"}</span>
                </div>
              </button>
            </li>
          ))
        )}
      </ul>

      {selected !== null ? (
        <>
          <CustomerDetail
            customer={selected}
            orders={orderRows}
            printJobs={printJobs}
            busy={ordersBusy}
            onClose={closeDetail}
            onOpenOrder={setDetailOrderId}
            {...(onOpenPickup === undefined ? {} : { onOpenPickup })}
          />
          <MemberBalancePanel
            customer={selected}
            queryClient={queryClient}
            commandClient={commandClient}
            {...(authClient === undefined ? {} : { authClient })}
            {...(session === undefined ? {} : { session })}
            toast={toast}
          />
          <CustomerGovernancePanel
            customer={selected}
            queryClient={queryClient}
            commandClient={commandClient}
            {...(authClient === undefined ? {} : { authClient })}
            {...(session === undefined ? {} : { session })}
            onUpdated={() => void selectCustomer(selected)}
            onMerged={() => {
              closeDetail();
              void search();
            }}
          />
          <CustomerPrivacyPanel
            customer={selected}
            queryClient={queryClient}
            commandClient={commandClient}
            {...(authClient === undefined ? {} : { authClient })}
            {...(session === undefined ? {} : { session })}
            onAnonymized={() => {
              closeDetail();
              void search();
            }}
          />
        </>
      ) : null}
      <OrderDetailDrawer
        open={detailOrderId !== null}
        orderId={detailOrderId}
        queryClient={queryClient}
        commandClient={commandClient}
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
