import { Input, MoneyText } from "@laundry/ui";

import type { PricingPolicyView } from "./pricing-policy-model.js";
import type { ReceiveGarmentDraft } from "./receive-garment-form.js";

export type ReceiveGarmentEditorProps = Readonly<{
  garment: ReceiveGarmentDraft;
  pieceIndex: number;
  busy: boolean;
  activeAddons: PricingPolicyView["addons"];
  onChange: (garment: ReceiveGarmentDraft) => void;
}>;

function patchGarment(
  garment: ReceiveGarmentDraft,
  patch: Partial<ReceiveGarmentDraft>,
): ReceiveGarmentDraft {
  return Object.freeze({ ...garment, ...patch, key: garment.key });
}

/** One physical garment's editable intake details and server-priced add-ons. */
export function ReceiveGarmentEditor({
  garment,
  pieceIndex,
  busy,
  activeAddons,
  onChange,
}: ReceiveGarmentEditorProps) {
  const label = `第 ${pieceIndex + 1} 件`;
  const activeCodes = new Set(activeAddons.map((addon) => addon.code));
  const inactiveCodes = garment.addon_codes.filter((code) => !activeCodes.has(code));
  return (
    <article className="ld-counter-piece" data-testid="receive-garment-editor">
      <h3 className="ld-counter-piece__title">{label}</h3>
      <div className="ld-counter-piece__fields">
        <Input
          name={`color-${garment.key}`}
          label="颜色"
          aria-label={`${label}颜色`}
          value={garment.color}
          onChange={(event) => onChange(patchGarment(garment, { color: event.target.value }))}
          disabled={busy}
        />
        <Input
          name={`brand-${garment.key}`}
          label="品牌"
          aria-label={`${label}品牌`}
          value={garment.brand}
          onChange={(event) => onChange(patchGarment(garment, { brand: event.target.value }))}
          disabled={busy}
        />
        <Input
          name={`defects-${garment.key}`}
          label="瑕疵"
          aria-label={`${label}瑕疵`}
          value={garment.defects_text}
          hint="多项用逗号分隔"
          onChange={(event) =>
            onChange(patchGarment(garment, { defects_text: event.target.value }))
          }
          disabled={busy}
        />
        <Input
          name={`accessories-${garment.key}`}
          label="随衣附件"
          aria-label={`${label}随衣附件`}
          value={garment.accessories_text}
          hint="多项用逗号分隔"
          onChange={(event) =>
            onChange(patchGarment(garment, { accessories_text: event.target.value }))
          }
          disabled={busy}
        />
        <Input
          name={`garment-note-${garment.key}`}
          label="件级备注"
          aria-label={`${label}件级备注`}
          value={garment.note}
          onChange={(event) => onChange(patchGarment(garment, { note: event.target.value }))}
          disabled={busy}
        />
      </div>
      {activeAddons.length === 0 && inactiveCodes.length === 0 ? null : (
        <fieldset className="ld-counter-line__addons">
          <legend>{label}附加项</legend>
          {activeAddons.map((addon) => {
            const selected = garment.addon_codes.includes(addon.code);
            return (
              <label key={addon.code}>
                <input
                  type="checkbox"
                  aria-label={`${label}${addon.name}`}
                  checked={selected}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? Object.freeze([...new Set([...garment.addon_codes, addon.code])])
                      : Object.freeze(garment.addon_codes.filter((code) => code !== addon.code));
                    onChange(patchGarment(garment, { addon_codes: next }));
                  }}
                  disabled={busy}
                />
                {addon.name}（<MoneyText fen={addon.unit_price_cents} size="sm" />
                /件）
              </label>
            );
          })}
          {inactiveCodes.map((code) => (
            <label key={code}>
              <input
                type="checkbox"
                aria-label={`${label}${code}（已停用）`}
                checked
                onChange={() =>
                  onChange(
                    patchGarment(garment, {
                      addon_codes: Object.freeze(
                        garment.addon_codes.filter((selected) => selected !== code),
                      ),
                    }),
                  )
                }
                disabled={busy}
              />
              {code}（已停用，取消后不能重选）
            </label>
          ))}
        </fieldset>
      )}
    </article>
  );
}
