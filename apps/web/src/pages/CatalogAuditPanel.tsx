import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import {
  CATALOG_AUDIT_ACTION_LABEL,
  readCatalogAuditRows,
  type CatalogAuditRow,
} from "./catalog-audit-model.js";

export function CatalogAuditPanel({ queryClient }: Readonly<{ queryClient: QueryPort }>) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [rows, setRows] = useState<readonly CatalogAuditRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (filterCode: string) => {
      const now = Math.floor(Date.now() / 1_000);
      const trimmed = filterCode.trim();
      setBusy(true);
      try {
        const result = await queryClient.execute<unknown>("catalog.audit.list", {
          from_epoch_s: Math.max(0, now - 30 * 24 * 60 * 60),
          to_epoch_s: now + 60,
          ...(trimmed.length === 0 ? {} : { code: trimmed }),
          limit: 50,
        });
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          setRows([]);
          return;
        }
        setRows(readCatalogAuditRows(result.data));
      } finally {
        setBusy(false);
      }
    },
    [queryClient, toast],
  );

  const reload = useCallback(async () => await load(code), [code, load]);

  useEffect(() => {
    void load("");
    // Initial store audit only. Explicit refresh applies later code filters.
  }, [load]);

  return (
    <section className="ld-catalog-audit lg-card" aria-label="价目审计" data-testid="catalog-audit">
      <h2 className="ld-shell-main__title">价目审计</h2>
      <p className="ld-shell-main__hint">仅显示近 30 天价目动作，不回传原始变更 JSON。</p>
      <div className="ld-catalog-audit__filter">
        <Input
          name="catalog-audit-code"
          label="按编码筛选（可选）"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={busy}
        />
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void reload()}>
          {busy ? "查询中…" : "查询审计"}
        </Button>
      </div>
      <ul className="ld-catalog-audit__list" data-testid="catalog-audit-list">
        {rows.map((row) => (
          <li key={row.id} className="ld-catalog-audit__row">
            <time dateTime={new Date(row.at_epoch_s * 1_000).toISOString()}>
              {new Date(row.at_epoch_s * 1_000).toLocaleString("zh-CN")}
            </time>
            <strong>{CATALOG_AUDIT_ACTION_LABEL[row.action]}</strong>
            <span>{row.codes.join("、") || "—"}</span>
            <span>{row.staff_id === null ? "系统" : `员工 …${row.staff_id.slice(-8)}`}</span>
          </li>
        ))}
      </ul>
      {!busy && rows.length === 0 ? <p role="status">筛选范围内没有价目审计记录</p> : null}
    </section>
  );
}
