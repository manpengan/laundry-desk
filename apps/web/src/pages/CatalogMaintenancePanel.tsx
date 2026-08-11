/**
 * ADR-15 price maintenance. Without this a fresh install cannot take an order:
 * order.receive resolves prices from the catalog and nothing else can write it.
 */

import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildCatalogReorderBody,
  buildCatalogUpsertBody,
  catalogFormFromRow,
  EMPTY_CATALOG_FORM,
  readCatalogRows,
  type CatalogFormRow,
  type CatalogFormState,
} from "./catalog-form.js";

export type CatalogMaintenancePanelProps = {
  commandClient: CommandPort;
  queryClient?: QueryPort;
};

export function CatalogMaintenancePanel({
  commandClient,
  queryClient,
}: CatalogMaintenancePanelProps) {
  const toast = useToast();
  const [form, setForm] = useState<CatalogFormState>(EMPTY_CATALOG_FORM);
  const [items, setItems] = useState<readonly CatalogFormRow[]>([]);
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);

  const patch = useCallback((next: Partial<CatalogFormState>) => {
    setForm((current) => Object.freeze({ ...current, ...next }));
  }, []);

  const reload = useCallback(async () => {
    if (queryClient === undefined) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const res = await queryClient.execute<unknown>("catalog.items.manage.list", { limit: 200 });
    if (loadGeneration.current !== generation) return;
    // The query bus wraps handler output in `result`; readCatalogRows also keeps
    // a malformed payload from ever reaching render as a non-array.
    if (!res.ok) {
      toast.push(res.error.message ?? res.error.code, "error");
      setItems([]);
      return;
    }
    setItems(readCatalogRows(res.data));
  }, [queryClient, toast]);

  useEffect(() => {
    void reload();
    return () => {
      loadGeneration.current += 1;
    };
  }, [reload]);

  const onSubmit = useCallback(
    async (override?: Partial<CatalogFormState>) => {
      const candidate = override === undefined ? form : Object.freeze({ ...form, ...override });
      const built = buildCatalogUpsertBody(candidate);
      if (!built.ok) {
        toast.push(built.message, "error");
        return;
      }
      setBusy(true);
      try {
        const res = await commandClient.execute("catalog.item.upsert", built.body);
        if (!res.ok) {
          if (res.error.code === "IDEMPOTENCY_CONFLICT") {
            setForm(EMPTY_CATALOG_FORM);
            toast.push("价目已被其他会话修改，列表已刷新，请重新编辑", "error");
            await reload();
          } else {
            toast.push(res.error.message ?? res.error.code, "error");
          }
          return;
        }
        toast.push(candidate.is_active ? "价目已保存" : "价目已停用", "success");
        setForm(EMPTY_CATALOG_FORM);
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [commandClient, form, reload, toast],
  );

  const onMove = useCallback(
    async (code: string, offset: -1 | 1) => {
      const active = items
        .filter((item) => item.is_active)
        .sort(
          (left, right) =>
            left.sort_order - right.sort_order || left.code.localeCompare(right.code),
        );
      const index = active.findIndex((item) => item.code === code);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= active.length) return;
      const reordered = active.map((item, itemIndex) =>
        itemIndex === index ? active[target]! : itemIndex === target ? active[index]! : item,
      );
      setBusy(true);
      try {
        const res = await commandClient.execute(
          "catalog.items.reorder",
          buildCatalogReorderBody(reordered),
        );
        if (!res.ok) {
          if (res.error.code === "IDEMPOTENCY_CONFLICT") {
            toast.push("价目顺序已被其他会话修改，列表已刷新，请重试", "error");
            await reload();
          } else {
            toast.push(res.error.message ?? res.error.code, "error");
          }
          return;
        }
        toast.push("价目顺序已保存", "success");
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [commandClient, items, reload, toast],
  );

  const activeOrder = items
    .filter((item) => item.is_active)
    .sort(
      (left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code),
    );
  const activeIndex = new Map(activeOrder.map((item, index) => [item.code, index]));

  return (
    <section
      className="ld-settings-catalog lg-card"
      aria-label="价目维护"
      data-testid="catalog-admin"
    >
      <div className="ld-settings-catalog__heading">
        <h2 className="ld-shell-main__title">价目维护</h2>
        <Button
          variant="ghost"
          type="button"
          onClick={() => void reload()}
          disabled={busy || queryClient === undefined}
        >
          刷新列表
        </Button>
      </div>
      <p className="ld-shell-main__hint">
        开单按服务 + 品类从在架价目中取价。停用只下架，不删除历史编码；版本冲突会要求刷新。
      </p>

      <div className="ld-settings-form">
        <Input
          name="catalog-code"
          label="编码"
          value={form.code}
          onChange={(event) => patch({ code: event.target.value })}
          hint="稳定唯一，如 wash_shirt"
          disabled={busy || form.expected_version > 0}
        />
        <Input
          name="catalog-name"
          label="名称"
          value={form.name}
          onChange={(event) => patch({ name: event.target.value })}
          disabled={busy}
        />
        <Input
          name="catalog-service"
          label="服务代码"
          value={form.service_code}
          onChange={(event) => patch({ service_code: event.target.value })}
          hint="小写，如 wash / dry / iron"
          disabled={busy}
        />
        <Input
          name="catalog-category"
          label="品类代码"
          value={form.category_code}
          onChange={(event) => patch({ category_code: event.target.value })}
          hint="小写，如 shirt / coat"
          disabled={busy}
        />
        <Input
          name="catalog-price"
          label="单价（分）"
          inputMode="numeric"
          value={form.price_text}
          onChange={(event) => patch({ price_text: event.target.value })}
          hint="整数分；1500 表示 ¥15.00"
          disabled={busy}
        />
        <Input
          name="catalog-mnemonic"
          label="助记码（可选）"
          value={form.mnemonic}
          onChange={(event) => patch({ mnemonic: event.target.value })}
          disabled={busy}
        />
        <div className="ld-settings-form__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void onSubmit()}
            disabled={busy}
            data-testid="catalog-save-btn"
          >
            {busy ? "提交中…" : "保存价目"}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setForm(EMPTY_CATALOG_FORM)}
            disabled={busy}
          >
            新建 / 清空
          </Button>
        </div>
      </div>

      <ul className="ld-settings-catalog__list" data-testid="catalog-admin-list">
        {items.map((item) => (
          <li key={item.code} className="ld-settings-catalog__row" data-testid="catalog-admin-row">
            <span className="ld-settings-catalog__name">{item.name}</span>
            <span className="ld-settings-catalog__code">{item.code}</span>
            <MoneyText fen={item.unit_price_cents} size="sm" />
            <span className="ld-settings-catalog__meta">
              {item.is_active ? `在架 · 顺序 ${item.sort_order + 1}` : "已停用"} · v{item.version}
            </span>
            <Button
              variant="ghost"
              type="button"
              disabled={busy || !item.is_active || activeIndex.get(item.code) === 0}
              onClick={() => void onMove(item.code, -1)}
              aria-label={`上移 ${item.name}`}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={
                busy || !item.is_active || activeIndex.get(item.code) === activeOrder.length - 1
              }
              onClick={() => void onMove(item.code, 1)}
              aria-label={`下移 ${item.name}`}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => setForm(catalogFormFromRow(item))}
            >
              编辑
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void onSubmit({ ...catalogFormFromRow(item), is_active: !item.is_active })
              }
            >
              {item.is_active ? "停用" : "启用"}
            </Button>
          </li>
        ))}
      </ul>
      {items.length === 0 ? (
        <p className="ld-settings-catalog__empty" role="status">
          还没有价目，先添加一条才能开单
        </p>
      ) : null}
    </section>
  );
}
