/** 扫码 / 搜索 (ADR-100): one field for tickets, pickup codes, barcodes, phones and names. */

import { Icon, Kbd, MoneyText, NumberPad, useToast } from "@laundry/ui";
import { useCallback, useId, useState, type KeyboardEvent } from "react";

import type { QueryPort } from "../../commands/types.js";
import { parseCustomerRows, type CustomerRowView } from "../customer-model.js";
import {
  ORDER_MATCH_LABELS,
  parseOrderLookupRows,
  type OrderLookupRowView,
} from "../OrderLookupCandidates.js";
import { unwrapQueryResult } from "../OrdersList.js";

const SHOWN_ORDERS = 6;
const SHOWN_CUSTOMERS = 3;

type Results = Readonly<{
  key: string;
  orders: readonly OrderLookupRowView[];
  customers: readonly CustomerRowView[];
}>;

type Option =
  | Readonly<{ kind: "order"; order: OrderLookupRowView }>
  | Readonly<{ kind: "customer"; customer: CustomerRowView }>
  | Readonly<{ kind: "all"; count: number }>;

export type ScanBoxProps = Readonly<{
  queryClient: QueryPort;
  onOpenPickup: (orderId: string) => void;
  onOpenPickupLookup: (key: string) => void;
  onOpenCustomer?: (query: string, customerId?: string) => void;
}>;

/** Pure: the choices the dropdown lists, in keyboard order. */
export function scanOptions(results: Results): readonly Option[] {
  const orders = results.orders.slice(0, SHOWN_ORDERS).map((order) => ({ kind: "order", order }));
  const customers = results.customers
    .slice(0, SHOWN_CUSTOMERS)
    .map((customer) => ({ kind: "customer", customer }));
  const all =
    results.orders.length > SHOWN_ORDERS ? [{ kind: "all", count: results.orders.length }] : [];
  return Object.freeze([...orders, ...customers, ...all] as Option[]);
}

async function lookup(queryClient: QueryPort, key: string) {
  const [orders, customers] = await Promise.all([
    queryClient.execute<unknown>("order.lookup", { key, status: "open", limit: 20 }),
    queryClient.execute<unknown>("customer.search", { query: key, limit: SHOWN_CUSTOMERS }),
  ]);
  if (!orders.ok) return { error: orders.error.message ?? orders.error.code } as const;
  const orderRows = parseOrderLookupRows(unwrapQueryResult(orders.data));
  if (orderRows === null) return { error: "订单查询结果无法解析" } as const;
  const customerRows = customers.ok ? parseCustomerRows(unwrapQueryResult(customers.data)) : null;
  return { orders: orderRows, customers: customerRows ?? [] } as const;
}

function orderHint(order: OrderLookupRowView): string {
  const pieces = order.garment_count === undefined ? "" : ` · ${order.garment_count} 件`;
  return `按${ORDER_MATCH_LABELS[order.matched_by]}匹配${pieces} · 待收 `;
}

function OptionRow({
  option,
  id,
  active,
  onPick,
}: Readonly<{ option: Option; id: string; active: boolean; onPick: () => void }>) {
  const icon =
    option.kind === "customer" ? "customers" : option.kind === "all" ? "arrowRight" : "pickup";
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className="ld-wb-scan__option"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span className="ld-wb-scan__option-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      {option.kind === "order" ? (
        <span className="ld-wb-scan__option-body">
          <strong>
            <span className="ld-wb-mono">{option.order.ticket_no ?? "挂单"}</span>
            {option.order.customer_name ?? "散客"}
          </strong>
          <small>
            {orderHint(option.order)}
            <MoneyText fen={option.order.balance_cents} size="sm" />
          </small>
        </span>
      ) : option.kind === "customer" ? (
        <span className="ld-wb-scan__option-body">
          <strong>{option.customer.name ?? "未命名客户"}</strong>
          <small className="ld-wb-mono">{option.customer.phone}</small>
        </span>
      ) : (
        <span className="ld-wb-scan__option-body">
          <strong>{`在取衣页查看全部 ${option.count} 单`}</strong>
        </span>
      )}
      <span className="ld-wb-scan__option-hint">
        {option.kind === "customer" ? "查看客户" : option.kind === "all" ? "打开" : "取衣"}
      </span>
    </li>
  );
}

export function ScanBox({
  queryClient,
  onOpenPickup,
  onOpenPickupLookup,
  onOpenCustomer,
}: ScanBoxProps) {
  const toast = useToast();
  const listId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const options = results === null ? [] : scanOptions(results);

  const pick = useCallback(
    (option: Option, key: string) => {
      setResults(null);
      if (option.kind === "order") onOpenPickup(option.order.order_id);
      else if (option.kind === "all") onOpenPickupLookup(key);
      else onOpenCustomer?.(key, option.customer.customer_id);
    },
    [onOpenCustomer, onOpenPickup, onOpenPickupLookup],
  );

  const search = useCallback(async () => {
    const key = value.trim();
    if (key.length === 0) {
      toast.push("请输入票号、取件码、衣物条码、手机号或姓名", "error");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const found = await lookup(queryClient, key);
      if ("error" in found) {
        toast.push(found.error, "error");
        return;
      }
      const only = found.orders.length === 1 ? found.orders[0] : undefined;
      if (only !== undefined) {
        onOpenPickup(only.order_id);
        return;
      }
      if (found.orders.length === 0 && found.customers.length === 0) {
        toast.push("未找到匹配订单；可按客户继续查找", "error");
        return;
      }
      setResults(Object.freeze({ key, orders: found.orders, customers: found.customers }));
      setActive(0);
    } finally {
      setBusy(false);
    }
  }, [busy, onOpenPickup, queryClient, toast, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const open = results !== null && options.length > 0;
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + options.length) % options.length);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      setResults(null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = open ? options[active] : undefined;
      if (chosen !== undefined && results !== null && results.key === value.trim()) {
        pick(chosen, results.key);
      } else void search();
    }
  };

  const open = results !== null && options.length > 0;
  return (
    <div className="ld-wb-scan">
      <div className="ld-wb-scan__field" data-busy={busy ? "true" : undefined}>
        <Icon name="scan" size={22} className="ld-wb-scan__icon" />
        <input
          name="quick-pickup"
          aria-label="扫码或搜索：票号、取件码、衣物条码、手机号、姓名"
          className="ld-wb-scan__input"
          value={value}
          placeholder={busy ? "查找中…" : "扫码枪直接扫，或输入后按 Enter"}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? `${listId}-list` : undefined}
          aria-activedescendant={open ? `${listId}-option-${active}` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setResults(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setResults(null)}
        />
        <Kbd>Enter</Kbd>
        <button
          type="button"
          className="ld-wb-scan__pad-toggle"
          aria-label="触屏数字键盘"
          aria-pressed={padOpen}
          onClick={() => setPadOpen((current) => !current)}
        >
          <Icon name="keyboard" size={18} />
        </button>
        {open ? (
          <ul
            id={`${listId}-list`}
            role="listbox"
            aria-label="匹配结果"
            className="ld-wb-scan__list"
          >
            <li className="ld-wb-scan__summary" role="presentation">
              {`“${results.key}” 找到 ${results.orders.length} 张未取订单、${results.customers.length} 位客户`}
            </li>
            {options.map((option, index) => (
              <OptionRow
                key={index}
                id={`${listId}-option-${index}`}
                option={option}
                active={index === active}
                onPick={() => pick(option, results.key)}
              />
            ))}
            <li className="ld-wb-scan__keys" role="presentation">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 选择 <Kbd>Enter</Kbd> 打开 <Kbd>Esc</Kbd> 关闭
            </li>
          </ul>
        ) : null}
      </div>
      <p className="ld-wb-scan__hint" aria-hidden="true">
        可扫 票号 · 取件码 · 衣物条码 · 手机号 · 姓名
      </p>
      {padOpen ? (
        <NumberPad
          value={value}
          onChange={(next) => {
            setValue(next);
            setResults(null);
          }}
          label="取件码数字键盘"
          className="ld-wb-scan__pad"
        />
      ) : null}
    </div>
  );
}
