/**
 * Price-list picker for 开单 — loads catalog.items.list over the query bus.
 */

import { Input, MoneyText } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogListItem } from "../commands/query-client.js";
import type { QueryPort } from "../commands/types.js";
import { unwrapCommandResult } from "./order-form.js";

const LIST_LIMIT = 50;
const DEBOUNCE_MS = 200;

export type CatalogPickerProps = {
  queryClient: QueryPort;
  disabled?: boolean;
  onPick: (item: CatalogListItem) => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

function parseCatalogItems(raw: unknown): readonly CatalogListItem[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const parsed: CatalogListItem[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.code !== "string" || typeof r.name !== "string") continue;
    if (typeof r.service_code !== "string" || typeof r.category_code !== "string") continue;
    if (typeof r.unit_price_cents !== "number" || !Number.isInteger(r.unit_price_cents)) continue;
    if (r.unit_price_cents < 0) continue;
    parsed.push(
      Object.freeze({
        code: r.code,
        name: r.name,
        service_code: r.service_code,
        category_code: r.category_code,
        unit_price_cents: r.unit_price_cents,
        ...(typeof r.mnemonic === "string" ? { mnemonic: r.mnemonic } : {}),
      }),
    );
  }
  return Object.freeze(parsed);
}

export function CatalogPicker({ queryClient, disabled = false, onPick }: CatalogPickerProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly CatalogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const seqRef = useRef(0);
  const firstLoadRef = useRef(true);

  const load = useCallback(
    async (text: string) => {
      const seq = (seqRef.current += 1);
      setState("loading");
      setErrorMsg(null);
      const res = await queryClient.execute<unknown>("catalog.items.list", {
        query: text,
        limit: LIST_LIMIT,
      });
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        setState("error");
        setItems([]);
        setTotal(0);
        setErrorMsg(res.error.message ?? res.error.code);
        return;
      }
      const payload = unwrapCommandResult<{ items?: unknown; total?: unknown }>(res.data);
      const next = parseCatalogItems(payload?.items);
      setItems(next);
      setTotal(typeof payload?.total === "number" ? payload.total : next.length);
      setState("ready");
    },
    [queryClient],
  );

  useEffect(() => {
    const delay = firstLoadRef.current ? 0 : DEBOUNCE_MS;
    firstLoadRef.current = false;
    const handle = setTimeout(() => {
      void load(query);
    }, delay);
    return () => clearTimeout(handle);
  }, [query, load]);

  return (
    <section className="ld-catalog-picker" aria-label="价目表" data-testid="catalog-picker">
      <div className="ld-catalog-picker__header">
        <h2 className="ld-catalog-picker__title">价目表</h2>
        <span className="ld-catalog-picker__meta">
          {state === "loading" ? "加载中…" : total > 0 ? `${total} 项` : null}
        </span>
      </div>
      <Input
        name="catalog-search"
        label="搜索价目"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        hint="名称 / 助记码 / 服务 / 品类"
        disabled={disabled}
        autoComplete="off"
      />
      {state === "error" && errorMsg !== null ? (
        <p className="ld-catalog-picker__error" role="alert">
          {errorMsg}
        </p>
      ) : null}
      {state === "ready" && items.length === 0 ? (
        <p className="ld-catalog-picker__empty" role="status">
          还没有价目
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="ld-catalog-picker__list" role="listbox" aria-label="价目列表">
          {items.map((item) => (
            <li key={item.code}>
              <button
                type="button"
                className="ld-catalog-picker__chip"
                role="option"
                disabled={disabled}
                onClick={() => onPick(item)}
              >
                <span className="ld-catalog-picker__name">{item.name}</span>
                <span className="ld-catalog-picker__price">
                  <MoneyText fen={item.unit_price_cents} size="sm" />
                </span>
                {item.mnemonic !== undefined && item.mnemonic.length > 0 ? (
                  <span className="ld-catalog-picker__mnemonic">{item.mnemonic}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
