/** 催取话术编辑：中文变量插入 + 按示例订单实时预览（渲染与服务端同源）。 */

import { isPickupReminderTemplate, renderPickupReminder } from "@laundry/domain";
import { Icon } from "@laundry/ui";
import { useRef } from "react";

const VARIABLES = Object.freeze([
  Object.freeze({ token: "{{tickets}}", label: "票号" }),
  Object.freeze({ token: "{{garment_count}}", label: "件数" }),
  Object.freeze({ token: "{{balance_yuan}}", label: "欠款（元）" }),
]);

const SAMPLE_GROUP = Object.freeze({
  key: "sample",
  order_ids: Object.freeze(["sample-order"]),
  ticket_nos: Object.freeze(["20261002-0001"]),
  customer_name: "王女士",
  customer_phone: "13800000000",
  garment_count: 3,
  balance_cents: 1500,
});

/** Pure: insert a token at the caret, replacing any selection. */
export function insertToken(
  text: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): Readonly<{ text: string; caret: number }> {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  return Object.freeze({
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    caret: start + token.length,
  });
}

export type ReminderTemplateEditorProps = Readonly<{
  template: string;
  onChange: (next: string) => void;
  /** First real message for the current selection, when available. */
  selectionPreview?: string;
}>;

export function ReminderTemplateEditor({
  template,
  onChange,
  selectionPreview,
}: ReminderTemplateEditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const valid = isPickupReminderTemplate(template);
  const preview = selectionPreview ?? (valid ? renderPickupReminder(template, SAMPLE_GROUP) : null);

  const insert = (token: string): void => {
    const area = areaRef.current;
    const next = insertToken(
      template,
      token,
      area?.selectionStart ?? template.length,
      area?.selectionEnd ?? template.length,
    );
    onChange(next.text);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="ld-reminder-template">
      <label className="ld-reminders__template">
        联系话术
        <textarea
          ref={areaRef}
          value={template}
          maxLength={256}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={valid ? undefined : true}
        />
      </label>
      <div className="ld-reminder-template__chips" role="group" aria-label="插入变量">
        <span>插入：</span>
        {VARIABLES.map((variable) => (
          <button
            key={variable.token}
            type="button"
            className="ld-reminder-template__chip"
            onClick={() => insert(variable.token)}
            title={`插入 ${variable.token}`}
          >
            <Icon name="plus" size={14} />
            {variable.label}
          </button>
        ))}
      </div>
      {valid ? (
        <p className="ld-reminder-template__preview">
          <span>{selectionPreview === undefined ? "示例预览" : "首条预览"}</span>
          {preview}
        </p>
      ) : (
        <p className="ld-reminder-template__error" role="alert">
          话术中有无法识别的变量，请只使用上方按钮插入的变量。
        </p>
      )}
      <p className="ld-reminder-template__note">
        “欠款”按“分”显示（1500 分 = ¥15.00），发送前请核对预览。
      </p>
    </div>
  );
}
