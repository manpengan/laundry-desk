import { Button, Input } from "@laundry/ui";

import { CustomerAddressEditor, CustomerIdentifierEditor } from "./CustomerProfileEditors.js";
import type { CustomerProfileDraft } from "./customer-profile-model.js";

const WAIVER_FIELDS = Object.freeze([
  Object.freeze({ key: "skip_ticket_print" as const, label: "跳过小票打印" }),
  Object.freeze({ key: "skip_label_print" as const, label: "跳过衣物标签打印" }),
  Object.freeze({ key: "skip_rack_assignment" as const, label: "跳过上挂分配" }),
]);

type CustomerProfileFormProps = Readonly<{
  draft: CustomerProfileDraft;
  busy: boolean;
  onChange: (draft: CustomerProfileDraft) => void;
  onSave: () => void;
}>;

export function CustomerProfileForm({ draft, busy, onChange, onSave }: CustomerProfileFormProps) {
  return (
    <>
      <div className="ld-customer-profile__base">
        <label>
          <span>称谓 / 性别</span>
          <select
            value={draft.gender}
            disabled={busy}
            onChange={(event) =>
              onChange(
                Object.freeze({
                  ...draft,
                  gender: event.target.value as CustomerProfileDraft["gender"],
                }),
              )
            }
          >
            <option value="unspecified">未指定</option>
            <option value="female">女</option>
            <option value="male">男</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>
          <span>首选联系渠道</span>
          <select
            value={draft.preferred_contact}
            disabled={busy}
            onChange={(event) =>
              onChange(
                Object.freeze({
                  ...draft,
                  preferred_contact: event.target
                    .value as CustomerProfileDraft["preferred_contact"],
                }),
              )
            }
          >
            <option value="none">未指定</option>
            <option value="phone">电话</option>
            <option value="sms">短信</option>
            <option value="wechat">微信</option>
          </select>
        </label>
        <label className="ld-customer-profile__wide">
          <span>服务偏好（内部）</span>
          <textarea
            value={draft.service_note}
            maxLength={256}
            disabled={busy}
            onChange={(event) =>
              onChange(Object.freeze({ ...draft, service_note: event.target.value }))
            }
          />
        </label>
      </div>

      <fieldset className="ld-customer-profile__waivers">
        <legend>订单运营豁免</legend>
        {WAIVER_FIELDS.map((field) => (
          <label key={field.key}>
            <input
              type="checkbox"
              checked={draft.waivers[field.key]}
              disabled={busy}
              onChange={(event) =>
                onChange(
                  Object.freeze({
                    ...draft,
                    waivers: Object.freeze({
                      ...draft.waivers,
                      [field.key]: event.target.checked,
                    }),
                  }),
                )
              }
            />
            <span>{field.label}</span>
          </label>
        ))}
        <p>仅对新订单冻结生效；不会改写历史订单，也不代表法律免责声明。</p>
      </fieldset>

      <CustomerAddressEditor
        addresses={draft.addresses}
        busy={busy}
        onChange={(addresses) => onChange(Object.freeze({ ...draft, addresses }))}
      />
      <CustomerIdentifierEditor
        identifiers={draft.identifiers}
        busy={busy}
        onChange={(identifiers) => onChange(Object.freeze({ ...draft, identifiers }))}
      />
      <div className="ld-customer-profile__save">
        <Input
          name="customer-profile-reason"
          label="档案变更原因"
          value={draft.reason}
          maxLength={256}
          disabled={busy}
          onChange={(event) => onChange(Object.freeze({ ...draft, reason: event.target.value }))}
          data-testid="customer-profile-reason"
        />
        <Button
          variant="primary"
          type="button"
          disabled={busy}
          onClick={onSave}
          data-testid="customer-profile-save"
        >
          保存扩展档案
        </Button>
      </div>
    </>
  );
}
