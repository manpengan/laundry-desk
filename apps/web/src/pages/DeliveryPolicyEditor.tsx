import { Button, Input, MoneyInput } from "@laundry/ui";
import { useCallback } from "react";

import {
  DELIVERY_WEEKDAYS,
  type DeliveryAreaDraft,
  type DeliveryPolicyDraft,
  type DeliveryWindowDraft,
} from "./delivery-policy-model.js";

export type DeliveryPolicyEditorProps = Readonly<{
  draft: DeliveryPolicyDraft;
  busy: boolean;
  loaded: boolean;
  onChange: (draft: DeliveryPolicyDraft) => void;
  onSave: () => void;
  onReload: () => void;
}>;

export function DeliveryPolicyEditor({
  draft,
  busy,
  loaded,
  onChange,
  onSave,
  onReload,
}: DeliveryPolicyEditorProps) {
  const patchDraft = useCallback(
    (patch: Partial<DeliveryPolicyDraft>) => onChange(Object.freeze({ ...draft, ...patch })),
    [draft, onChange],
  );
  const patchArea = useCallback(
    (rowId: string, patch: Partial<DeliveryAreaDraft>) =>
      patchDraft({
        service_areas: Object.freeze(
          draft.service_areas.map((area) =>
            area.row_id === rowId
              ? Object.freeze({ ...area, ...patch, row_id: area.row_id })
              : area,
          ),
        ),
      }),
    [draft.service_areas, patchDraft],
  );
  const patchWindow = useCallback(
    (rowId: string, patch: Partial<DeliveryWindowDraft>) =>
      patchDraft({
        weekly_windows: Object.freeze(
          draft.weekly_windows.map((window) =>
            window.row_id === rowId
              ? Object.freeze({ ...window, ...patch, row_id: window.row_id })
              : window,
          ),
        ),
      }),
    [draft.weekly_windows, patchDraft],
  );
  const disabled = busy || !loaded;

  return (
    <div className="ld-delivery-policy__editor">
      <h3 className="ld-delivery-policy__heading">预约规则</h3>
      <label className="ld-delivery-policy__toggle">
        <input
          type="checkbox"
          checked={draft.accepting_appointments}
          onChange={(event) => patchDraft({ accepting_appointments: event.target.checked })}
          disabled={disabled}
        />
        策略允许预约（仍受门店取送功能开关控制）
      </label>
      <div className="ld-delivery-policy__rules">
        <Input
          label="最短提前分钟"
          inputMode="numeric"
          value={draft.minimum_lead_text}
          onChange={(event) => patchDraft({ minimum_lead_text: event.target.value })}
          disabled={disabled}
        />
        <Input
          label="最远提前天数"
          inputMode="numeric"
          value={draft.maximum_advance_text}
          onChange={(event) => patchDraft({ maximum_advance_text: event.target.value })}
          disabled={disabled}
        />
        <Input
          label="预约格分钟"
          inputMode="numeric"
          value={draft.slot_text}
          onChange={(event) => patchDraft({ slot_text: event.target.value })}
          disabled={disabled}
        />
        <Input
          label="每格策略上限"
          inputMode="numeric"
          value={draft.capacity_text}
          onChange={(event) => patchDraft({ capacity_text: event.target.value })}
          disabled={disabled}
        />
      </div>

      <div className="ld-delivery-policy__group">
        <h3 className="ld-delivery-policy__heading">服务区域与运费</h3>
        {draft.service_areas.map((area) => (
          <article key={area.row_id} className="ld-delivery-policy__area">
            <Input
              label="区域编码"
              value={area.code}
              onChange={(event) => patchArea(area.row_id, { code: event.target.value })}
              disabled={disabled}
            />
            <Input
              label="区域名称"
              value={area.name}
              onChange={(event) => patchArea(area.row_id, { name: event.target.value })}
              disabled={disabled}
            />
            <MoneyInput
              label="单次运费"
              valueFen={area.fee_text}
              onChangeFen={(fen) => patchArea(area.row_id, { fee_text: fen })}
              disabled={disabled}
            />
            <label className="ld-delivery-policy__toggle">
              <input
                type="checkbox"
                checked={area.is_active}
                onChange={(event) => patchArea(area.row_id, { is_active: event.target.checked })}
                disabled={disabled}
              />
              启用
            </label>
            <Button
              variant="ghost"
              type="button"
              onClick={() =>
                patchDraft({
                  service_areas: Object.freeze(
                    draft.service_areas.filter((item) => item.row_id !== area.row_id),
                  ),
                })
              }
              disabled={disabled}
            >
              移除
            </Button>
          </article>
        ))}
        <Button
          variant="secondary"
          type="button"
          onClick={() =>
            patchDraft({
              service_areas: Object.freeze([
                ...draft.service_areas,
                Object.freeze({
                  row_id: `area-new-${Date.now()}`,
                  code: "",
                  name: "",
                  fee_text: "0",
                  is_active: true,
                }),
              ]),
            })
          }
          disabled={disabled || draft.service_areas.length >= 20}
        >
          添加服务区域
        </Button>
      </div>

      <div className="ld-delivery-policy__group">
        <h3 className="ld-delivery-policy__heading">每周取送时段</h3>
        {draft.weekly_windows.map((window) => (
          <article key={window.row_id} className="ld-delivery-policy__window">
            <label className="ld-delivery-policy__field">
              <span>星期</span>
              <select
                value={window.weekday}
                onChange={(event) =>
                  patchWindow(window.row_id, { weekday: Number(event.target.value) })
                }
                disabled={disabled}
              >
                {DELIVERY_WEEKDAYS.map((weekday) => (
                  <option key={weekday.value} value={weekday.value}>
                    {weekday.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="开始（HH:MM）"
              value={window.start_text}
              onChange={(event) => patchWindow(window.row_id, { start_text: event.target.value })}
              disabled={disabled}
            />
            <Input
              label="结束（可填 24:00）"
              value={window.end_text}
              onChange={(event) => patchWindow(window.row_id, { end_text: event.target.value })}
              disabled={disabled}
            />
            <Button
              variant="ghost"
              type="button"
              onClick={() =>
                patchDraft({
                  weekly_windows: Object.freeze(
                    draft.weekly_windows.filter((item) => item.row_id !== window.row_id),
                  ),
                })
              }
              disabled={disabled}
            >
              移除
            </Button>
          </article>
        ))}
        <Button
          variant="secondary"
          type="button"
          onClick={() =>
            patchDraft({
              weekly_windows: Object.freeze([
                ...draft.weekly_windows,
                Object.freeze({
                  row_id: `window-new-${Date.now()}`,
                  weekday: 1,
                  start_text: "09:00",
                  end_text: "17:00",
                }),
              ]),
            })
          }
          disabled={disabled || draft.weekly_windows.length >= 28}
        >
          添加服务时段
        </Button>
      </div>

      <div className="ld-settings-form__actions">
        <Button variant="primary" type="button" onClick={onSave} disabled={disabled}>
          {busy ? "提交中…" : "保存取送策略"}
        </Button>
        <Button variant="ghost" type="button" onClick={onReload} disabled={busy}>
          重新读取
        </Button>
      </div>
    </div>
  );
}
