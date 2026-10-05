import { Button, Icon, Input, MoneyText } from "@laundry/ui";

import type { CatalogListItem } from "../commands/query-client.js";
import { garmentName } from "./garment-labels.js";
import { serviceLabel } from "./catalog-services.js";
import { parsePositiveInt } from "./order-form.js";
import type { PricingPolicyView } from "./pricing-policy-model.js";
import { ReceiveGarmentEditor } from "./ReceiveGarmentEditor.js";
import {
  newLineDraft,
  resizeGarmentDrafts,
  type ReceiveGarmentDraft,
  type ReceiveLineDraft,
} from "./receive-garment-form.js";

const MAX_QTY = 50;

export type ReceiveLineEditorProps = Readonly<{
  lines: readonly ReceiveLineDraft[];
  focusedLineKey: string | null;
  busy: boolean;
  activeAddons?: PricingPolicyView["addons"];
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

/** Manual code edits drop the catalog price and the catalog display name. */
function manualCodePatch(
  line: ReceiveLineDraft,
  patch: Pick<Partial<ReceiveLineDraft>, "service_code" | "category_code">,
): ReceiveLineDraft {
  const { catalog_name: _dropped, ...rest } = line;
  void _dropped;
  return Object.freeze({ ...rest, ...patch, unit_price_cents: null });
}

function isBlankLine(line: ReceiveLineDraft): boolean {
  return line.service_code.trim() === "" && line.category_code.trim() === "";
}

function lineFromCatalog(item: CatalogListItem, index: number): ReceiveLineDraft {
  return Object.freeze({
    ...newLineDraft(index),
    service_code: item.service_code,
    category_code: item.category_code,
    unit_price_cents: item.unit_price_cents,
    catalog_name: item.name,
  });
}

function updateGarment(line: ReceiveLineDraft, garment: ReceiveGarmentDraft): ReceiveLineDraft {
  return Object.freeze({
    ...line,
    garments: Object.freeze(
      line.garments.map((current) => (current.key === garment.key ? garment : current)),
    ),
  });
}

function withQty(line: ReceiveLineDraft, qtyText: string): Partial<ReceiveLineDraft> {
  const qty = parsePositiveInt(qtyText, MAX_QTY);
  return {
    qty: qtyText,
    ...(qty === null ? {} : { garments: resizeGarmentDrafts(line.garments, qty, line.key) }),
  };
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
    catalog_name: item.name,
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
  activeAddons = Object.freeze([]),
  onFocusLine,
  onChange,
}: ReceiveLineEditorProps) {
  const garmentCount = lines.reduce((sum, line) => sum + line.garments.length, 0);
  return (
    <section className="ld-counter-panel ld-receive-lines" aria-label="衣物明细">
      <div className="ld-counter-panel__head">
        <h2 className="ld-counter-panel__title">
          <Icon name="shirt" size={18} />
          衣物明细
        </h2>
        <span className="ld-counter-panel__meta">
          {lines.length} 行 · {garmentCount} 件
        </span>
      </div>
      <div className="ld-counter-lines">
        {lines.map((line, index) => {
          const selected = line.key === focusedLineKey;
          const qty = parsePositiveInt(line.qty, MAX_QTY) ?? 0;
          return (
            <article
              className={selected ? "ld-counter-line ld-counter-line--selected" : "ld-counter-line"}
              key={line.key}
            >
              <div className="ld-counter-line__head">
                <span className="ld-counter-line__index">{index + 1}</span>
                <button
                  type="button"
                  className="ld-counter-line__summary"
                  onClick={() => onFocusLine(line.key)}
                  aria-pressed={selected}
                  title="选中后，再点选价目会替换本行"
                >
                  <strong>
                    {line.catalog_name ??
                      (isBlankLine(line)
                        ? "请选择价目"
                        : garmentName(line.service_code, line.category_code))}
                  </strong>
                  <span>
                    {isBlankLine(line)
                      ? "点选或搜索价目加入"
                      : `${serviceLabel(line.service_code)} · ${line.category_code}`}
                  </span>
                </button>
                <div className="ld-counter-line__price">
                  <span>价目单价</span>
                  {line.unit_price_cents === null ? (
                    <strong>待定价</strong>
                  ) : (
                    <MoneyText fen={line.unit_price_cents} />
                  )}
                </div>
                <div className="ld-counter-qty">
                  <button
                    type="button"
                    className="ld-counter-qty__step"
                    aria-label={`第 ${index + 1} 行减一件`}
                    disabled={busy || qty <= 1}
                    onClick={() =>
                      onChange(updateLine(lines, line.key, withQty(line, String(qty - 1))))
                    }
                  >
                    <Icon name="minus" size={16} />
                  </button>
                  <Input
                    name={`qty-${line.key}`}
                    label="数量"
                    inputMode="numeric"
                    value={line.qty}
                    onFocus={() => onFocusLine(line.key)}
                    onChange={(event) =>
                      onChange(updateLine(lines, line.key, withQty(line, event.target.value)))
                    }
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="ld-counter-qty__step"
                    aria-label={`第 ${index + 1} 行加一件`}
                    disabled={busy || qty >= MAX_QTY}
                    onClick={() =>
                      onChange(updateLine(lines, line.key, withQty(line, String(qty + 1))))
                    }
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </div>
                <button
                  type="button"
                  className="ld-counter-line__remove"
                  aria-label={`删除第 ${index + 1} 行`}
                  title="删除本行"
                  onClick={() => onChange(lines.filter((item) => item.key !== line.key))}
                  disabled={busy || lines.length <= 1}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
              <details
                className="ld-counter-line__codes"
                open={isBlankLine(line) && lines.length > 1}
              >
                <summary>手动输入编码（价目中没有时使用）</summary>
                <div className="ld-counter-line__code-fields">
                  <Input
                    name={`service-${line.key}`}
                    label="服务"
                    value={line.service_code}
                    onFocus={() => onFocusLine(line.key)}
                    onChange={(event) =>
                      onChange(
                        lines.map((item) =>
                          item.key === line.key
                            ? manualCodePatch(item, { service_code: event.target.value })
                            : item,
                        ),
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
                        lines.map((item) =>
                          item.key === line.key
                            ? manualCodePatch(item, { category_code: event.target.value })
                            : item,
                        ),
                      )
                    }
                    disabled={busy}
                  />
                </div>
              </details>
              <div className="ld-counter-pieces">
                {line.garments.map((garment, pieceIndex) => (
                  <ReceiveGarmentEditor
                    key={garment.key}
                    garment={garment}
                    pieceIndex={pieceIndex}
                    busy={busy}
                    activeAddons={activeAddons}
                    onChange={(next) =>
                      onChange(
                        lines.map((current) =>
                          current.key === line.key ? updateGarment(current, next) : current,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </article>
          );
        })}
      </div>
      <Button
        variant="secondary"
        type="button"
        onClick={() => onChange([...lines, newLineDraft(lines.length)])}
        disabled={busy}
      >
        <Icon name="plus" size={16} />
        添加一行
      </Button>
    </section>
  );
}
