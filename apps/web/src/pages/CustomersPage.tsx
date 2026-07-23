/**
 * 客户档案 — customer.search + customer.upsert (M2 skeleton).
 */

import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";

export type CustomerRowView = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

export type CustomersPageProps = {
  queryClient: QueryPort;
  commandClient: CommandPort;
  /** Skip auto-search on mount (tests). */
  autoLoad?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseCustomerRows(value: unknown): readonly CustomerRowView[] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.customers)) return null;
  const rows: CustomerRowView[] = [];
  for (const item of value.customers) {
    if (!isRecord(item)) return null;
    if (typeof item.customer_id !== "string") return null;
    if (typeof item.phone !== "string") return null;
    if (typeof item.updated_at !== "number" || !Number.isSafeInteger(item.updated_at)) return null;
    const name = item.name === null || item.name === undefined ? null : String(item.name);
    const note = item.note === null || item.note === undefined ? null : String(item.note);
    rows.push(
      Object.freeze({
        customer_id: item.customer_id,
        phone: item.phone,
        name,
        note,
        updated_at: item.updated_at,
      }),
    );
  }
  return Object.freeze(rows);
}

const PHONE_RE = /^1[3-9]\d{9}$/u;

export function CustomersPage({ queryClient, commandClient, autoLoad = true }: CustomersPageProps) {
  const toast = useToast();
  const [queryText, setQueryText] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly CustomerRowView[]>([]);
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
        组织级客户档案：按手机号前缀或姓名搜索；建档手机号使用种子段 13800000xxx。
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
            <li
              key={row.customer_id}
              className="ld-customers-list__row"
              data-testid="customers-row"
            >
              <div className="ld-customers-list__main">
                <span className="ld-customers-list__phone ld-customers-phone-internal">
                  {row.phone}
                </span>
                <span className="ld-customers-list__name">{row.name ?? "—"}</span>
              </div>
              {row.note !== null && row.note.length > 0 ? (
                <div className="ld-customers-list__note">{row.note}</div>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
