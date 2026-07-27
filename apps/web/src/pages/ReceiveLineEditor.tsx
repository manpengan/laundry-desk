import { Button, Input, MoneyText } from "@laundry/ui";

import type { CatalogListItem } from "../commands/query-client.js";
import { newLineDraft, type ReceiveLineDraft } from "./order-form.js";

export type ReceiveLineEditorProps = Readonly<{
  lines: readonly ReceiveLineDraft[];
  focusedLineKey: string | null;
  busy: boolean;
  onFocusLine: (key: string) => void;
  onChange: (lines: readonly ReceiveLineDraft[]) => void;
}>;

function updateLine(
  lines: readonly ReceiveLineDraft[],
  key: string,
  patch: Partial<ReceiveLineDraft>,
): readonly ReceiveLineDraft[] {
  return lines.map((line) =>
    line.key === key ? Object.freeze({ ...line, ...patch, key: line.key }) : line,
  );
}

function isBlankLine(line: ReceiveLineDraft): boolean {
  return line.service_code.trim() === "" && line.category_code.trim() === "";
}

function lineFromCatalog(item: CatalogListItem, index: number): ReceiveLineDraft {
  return Object.freeze({
    key: `line-${index}-${Date.now()}`,
    service_code: item.service_code,
    category_code: item.category_code,
    unit_price_cents: item.unit_price_cents,
    qty: "1",
  });
}

/** Apply a catalog choice to the focused/empty row, never accepting a manual price. */
export function applyCatalogPick(
  lines: readonly ReceiveLineDraft[],
  focusedKey: string | null,
  item: CatalogListItem,
): Readonly<{ lines: readonly ReceiveLineDraft[]; focusedKey: string }> {
  const patch = {
    service_code: item.service_code,
    category_code: item.category_code,
    unit_price_cents: item.unit_price_cents,
    qty: "1",
  };
  const target =
    (focusedKey === null ? undefined : lines.find((line) => line.key === focusedKey)) ??
    lines.find(isBlankLine);
  if (target !== undefined) {
    return Object.freeze({ lines: updateLine(lines, target.key, patch), focusedKey: target.key });
  }
  const next = lineFromCatalog(item, lines.length);
  return Object.freeze({ lines: [...lines, next], focusedKey: next.key });
}

export function ReceiveLineEditor({
  lines,
  focusedLineKey,
  busy,
  onFocusLine,
  onChange,
}: ReceiveLineEditorProps) {
  return (
    <section className="ld-counter-panel" aria-label="衣物明细">
      <div className="ld-counter-panel__head">
        <h2 className="ld-counter-panel__title">衣物明细</h2>
        <span className="ld-counter-panel__meta">{lines.length} 行</span>
      </div>
      <div className="ld-counter-lines">
        {lines.map((line, index) => (
          <article className="ld-counter-line" key={line.key}>
            <span className="ld-counter-line__index">#{index + 1}</span>
            <div className="ld-counter-line__codes">
              <Input
                name={`service-${line.key}`}
                label="服务"
                value={line.service_code}
                onFocus={() => onFocusLine(line.key)}
                onChange={(event) =>
                  onChange(
                    updateLine(lines, line.key, {
                      service_code: event.target.value,
                      unit_price_cents: null,
                    }),
                  )
                }
                disabled={busy}
              />
              <Input
                name={`category-${line.key}`}
                label="品类"
                value={line.category_code}
                onFocus={() => onFocusLine(line.key)}
                onChange={(event) =>
                  onChange(
                    updateLine(lines, line.key, {
                      category_code: event.target.value,
                      unit_price_cents: null,
                    }),
                  )
                }
                disabled={busy}
              />
            </div>
            <div className="ld-counter-line__price">
              <span>价目单价</span>
              {line.unit_price_cents === null ? (
                <strong>请从左侧选择</strong>
              ) : (
                <MoneyText fen={line.unit_price_cents} />
              )}
            </div>
            <Input
              name={`qty-${line.key}`}
              label="数量"
              inputMode="numeric"
              value={line.qty}
              onFocus={() => onFocusLine(line.key)}
              onChange={(event) =>
                onChange(updateLine(lines, line.key, { qty: event.target.value }))
              }
              disabled={busy}
            />
            <Button
              variant="ghost"
              type="button"
              size="sm"
              onClick={() =>
                onChange(lines.length <= 1 ? lines : lines.filter((item) => item.key !== line.key))
              }
              disabled={busy || lines.length <= 1}
            >
              删除
            </Button>
          </article>
        ))}
      </div>
      <Button
        variant="secondary"
        type="button"
        onClick={() => onChange([...lines, newLineDraft(lines.length)])}
        disabled={busy}
      >
        添加一行
      </Button>
      {focusedLineKey === null ? null : (
        <p className="ld-counter-panel__hint">
          当前编辑行已选中；从左侧价目表点选会覆盖其服务与单价。
        </p>
      )}
    </section>
  );
}
