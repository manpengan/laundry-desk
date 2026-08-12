import { Button } from "@laundry/ui";

import type { CustomerAddressDraft, CustomerIdentifierDraft } from "./customer-profile-model.js";

type AddressEditorProps = Readonly<{
  addresses: readonly CustomerAddressDraft[];
  busy: boolean;
  onChange: (addresses: readonly CustomerAddressDraft[]) => void;
}>;

function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function CustomerAddressEditor({ addresses, busy, onChange }: AddressEditorProps) {
  const replace = (index: number, next: CustomerAddressDraft): void => {
    onChange(Object.freeze(addresses.map((address, at) => (at === index ? next : address))));
  };
  const setDefault = (index: number, checked: boolean): void => {
    onChange(
      Object.freeze(
        addresses.map((address, at) =>
          Object.freeze({
            ...address,
            is_default: at === index ? checked : checked ? false : address.is_default,
          }),
        ),
      ),
    );
  };
  return (
    <section className="ld-customer-profile__collection" aria-label="顾客地址">
      <div className="ld-customer-profile__collection-head">
        <div>
          <h4>地址</h4>
          <p>最多 10 个；默认地址最多一个。旧地址正文在替换时会清除。</p>
        </div>
        <Button
          variant="ghost"
          type="button"
          disabled={busy || addresses.length >= 10}
          onClick={() =>
            onChange(
              Object.freeze([
                ...addresses,
                Object.freeze({
                  key: newKey("address"),
                  label: "",
                  recipient: "",
                  contact_phone: "",
                  address: "",
                  is_default: addresses.length === 0,
                }),
              ]),
            )
          }
          data-testid="customer-profile-address-add"
        >
          添加地址
        </Button>
      </div>
      {addresses.length === 0 ? <p className="ld-customer-profile__empty">暂无地址</p> : null}
      {addresses.map((address, index) => (
        <fieldset key={address.key} className="ld-customer-profile__row">
          <legend>地址 {index + 1}</legend>
          <label>
            <span>标签</span>
            <input
              value={address.label}
              maxLength={32}
              disabled={busy}
              onChange={(event) =>
                replace(index, Object.freeze({ ...address, label: event.target.value }))
              }
            />
          </label>
          <label>
            <span>收件人（可选）</span>
            <input
              value={address.recipient}
              maxLength={64}
              disabled={busy}
              onChange={(event) =>
                replace(index, Object.freeze({ ...address, recipient: event.target.value }))
              }
            />
          </label>
          <label>
            <span>联系电话（可选）</span>
            <input
              value={address.contact_phone}
              maxLength={32}
              disabled={busy}
              onChange={(event) =>
                replace(index, Object.freeze({ ...address, contact_phone: event.target.value }))
              }
            />
          </label>
          <label className="ld-customer-profile__wide">
            <span>地址</span>
            <input
              value={address.address}
              maxLength={256}
              disabled={busy}
              onChange={(event) =>
                replace(index, Object.freeze({ ...address, address: event.target.value }))
              }
            />
          </label>
          <label className="ld-customer-profile__check">
            <input
              type="checkbox"
              checked={address.is_default}
              disabled={busy}
              onChange={(event) => setDefault(index, event.target.checked)}
            />
            <span>默认地址</span>
          </label>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => onChange(Object.freeze(addresses.filter((_, at) => at !== index)))}
          >
            删除
          </Button>
        </fieldset>
      ))}
    </section>
  );
}

type IdentifierEditorProps = Readonly<{
  identifiers: readonly CustomerIdentifierDraft[];
  busy: boolean;
  onChange: (identifiers: readonly CustomerIdentifierDraft[]) => void;
}>;

export function CustomerIdentifierEditor({ identifiers, busy, onChange }: IdentifierEditorProps) {
  const replace = (index: number, next: CustomerIdentifierDraft): void => {
    onChange(
      Object.freeze(identifiers.map((identifier, at) => (at === index ? next : identifier))),
    );
  };
  return (
    <section className="ld-customer-profile__collection" aria-label="顾客标识">
      <div className="ld-customer-profile__collection-head">
        <div>
          <h4>车辆与外部标识</h4>
          <p>可用于客户搜索；列表不会显示标识值。相同类型的值在组织内唯一。</p>
        </div>
        <Button
          variant="ghost"
          type="button"
          disabled={busy || identifiers.length >= 20}
          onClick={() =>
            onChange(
              Object.freeze([
                ...identifiers,
                Object.freeze({ key: newKey("identifier"), kind: "vehicle_plate", value: "" }),
              ]),
            )
          }
          data-testid="customer-profile-identifier-add"
        >
          添加标识
        </Button>
      </div>
      {identifiers.length === 0 ? <p className="ld-customer-profile__empty">暂无标识</p> : null}
      {identifiers.map((identifier, index) => (
        <fieldset key={identifier.key} className="ld-customer-profile__row">
          <legend>标识 {index + 1}</legend>
          <label>
            <span>类型</span>
            <select
              value={identifier.kind}
              disabled={busy}
              onChange={(event) =>
                replace(
                  index,
                  Object.freeze({
                    ...identifier,
                    kind: event.target.value as CustomerIdentifierDraft["kind"],
                  }),
                )
              }
            >
              <option value="vehicle_plate">车牌</option>
              <option value="tag">门店标签</option>
              <option value="external_ref">外部编号</option>
            </select>
          </label>
          <label className="ld-customer-profile__wide">
            <span>值</span>
            <input
              value={identifier.value}
              maxLength={64}
              disabled={busy}
              onChange={(event) =>
                replace(index, Object.freeze({ ...identifier, value: event.target.value }))
              }
            />
          </label>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => onChange(Object.freeze(identifiers.filter((_, at) => at !== index)))}
          >
            删除
          </Button>
        </fieldset>
      ))}
    </section>
  );
}
