/**
 * Price-list picker for 开单 — loads catalog.items.list over the query bus.
 * UI spec §4.2: service tabs (F1–F11), always-ready mnemonic search, tile grid.
 */

import { Icon, Input, MoneyText, Tabs } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CatalogListItem } from "../commands/query-client.js";
import type { QueryPort } from "../commands/types.js";
import {
  catalogServices,
  functionKeyForTab,
  serviceForFunctionKey,
  serviceLabel,
} from "./catalog-services.js";
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function focusOption(list: HTMLElement | null, index: number): void {
  const options = list?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)');
  if (options === undefined || options.length === 0) return;
  const bounded = Math.max(0, Math.min(index, options.length - 1));
  options[bounded]?.focus();
}

export function CatalogPicker({ queryClient, disabled = false, onPick }: CatalogPickerProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly CatalogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [service, setService] = useState<string>("all");
  const seqRef = useRef(0);
  const firstLoadRef = useRef(true);
  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const services = useMemo(() => catalogServices(items), [items]);
  const visible = useMemo(
    () => (service === "all" ? items : items.filter((item) => item.service_code === service)),
    [items, service],
  );

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

  // F1–F11 switch service tabs; "/" jumps to search — only while 开单 is open.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing || document.querySelector('[aria-modal="true"]') !== null) return;
      const target = serviceForFunctionKey(event.key, services);
      if (target !== null) {
        event.preventDefault();
        setService(target);
        return;
      }
      if (event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault();
        rootRef.current?.querySelector<HTMLInputElement>('input[name="catalog-search"]')?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [services]);

  const pick = (item: CatalogListItem | undefined): void => {
    if (item === undefined || disabled) return;
    onPick(item);
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta !== 0) {
      event.preventDefault();
      focusOption(listRef.current, index + delta);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusOption(listRef.current, event.key === "Home" ? 0 : visible.length - 1);
    }
  };

  const tabs = [
    { id: "all", label: "全部", hint: "F1" },
    ...services.slice(0, 10).map((code, index) => {
      const hint = functionKeyForTab(index + 1);
      return hint === undefined
        ? { id: code, label: serviceLabel(code) }
        : { id: code, label: serviceLabel(code), hint };
    }),
  ];

  return (
    <section
      ref={rootRef}
      className="ld-catalog-picker"
      aria-label="价目表"
      data-testid="catalog-picker"
    >
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
        hint="名称 / 助记码；Enter 加入第一项，/ 键随时回到这里"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (visible[0] !== undefined) {
              pick(visible[0]);
              setQuery("");
            }
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            focusOption(listRef.current, 0);
          }
        }}
      />
      {services.length > 1 ? (
        <Tabs label="服务类别" items={tabs} value={service} onChange={setService} />
      ) : null}
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
      {visible.length > 0 ? (
        <ul ref={listRef} className="ld-catalog-picker__list" role="listbox" aria-label="价目列表">
          {visible.map((item, index) => (
            <li key={item.code} role="none">
              <button
                type="button"
                className="ld-catalog-picker__chip"
                role="option"
                aria-selected={false}
                disabled={disabled}
                onClick={() => pick(item)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
              >
                <span className="ld-catalog-picker__name">{item.name}</span>
                <span className="ld-catalog-picker__price">
                  <MoneyText fen={item.unit_price_cents} size="md" />
                </span>
                <span className="ld-catalog-picker__tags">
                  <span>{serviceLabel(item.service_code)}</span>
                  {item.mnemonic !== undefined && item.mnemonic.length > 0 ? (
                    <span className="ld-catalog-picker__mnemonic">{item.mnemonic}</span>
                  ) : null}
                </span>
                <span className="ld-catalog-picker__add" aria-hidden="true">
                  <Icon name="plus" size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
