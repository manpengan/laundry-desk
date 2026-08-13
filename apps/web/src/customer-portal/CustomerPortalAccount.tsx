import { useEffect, useState, type FormEvent } from "react";

import type {
  CustomerPortalBenefitsResult,
  CustomerPortalProfileResult,
  CustomerPortalProfileUpdateInput,
  CustomerPortalWalletResult,
} from "@laundry/contracts";

import { formatCustomerPortalCents } from "./model.js";

type PortalAddress = CustomerPortalProfileUpdateInput["addresses"][number];

export type CustomerPortalAccountProps = Readonly<{
  wallet: CustomerPortalWalletResult["wallet"];
  benefits: CustomerPortalBenefitsResult["benefits"];
  profile: CustomerPortalProfileResult | null;
  busy: boolean;
  onRefresh(): void;
  onSave(input: CustomerPortalProfileUpdateInput): void;
}>;

const contactLabel = Object.freeze({
  none: "不设置",
  phone: "电话",
  sms: "短信",
  wechat: "微信",
});

function Benefits({ benefits }: Pick<CustomerPortalAccountProps, "benefits">) {
  if (benefits === null) return <p className="ld-customer-muted">尚未开通会员权益。</p>;
  return (
    <div className="ld-customer-benefit-grid">
      <span>
        <small>等级</small>
        <strong>{benefits.tier?.name ?? "普通会员"}</strong>
      </span>
      <span>
        <small>可用积分</small>
        <strong>{benefits.available_points}</strong>
      </span>
      <span>
        <small>次卡</small>
        <strong>{benefits.punch_cards.filter((card) => card.status === "active").length} 张</strong>
      </span>
      <span>
        <small>券包</small>
        <strong>{benefits.coupons.filter((coupon) => coupon.status === "active").length} 张</strong>
      </span>
    </div>
  );
}

function ProfileForm({ profile, busy, onSave }: CustomerPortalAccountProps) {
  const [preference, setPreference] = useState(profile?.preferred_contact ?? "none");
  const [addresses, setAddresses] = useState<readonly PortalAddress[]>([]);
  const storeAddresses = profile?.addresses.filter((address) => address.source === "store") ?? [];
  const storeHasDefault = storeAddresses.some((address) => address.is_default);
  const capacity = Math.max(0, 10 - storeAddresses.length);

  useEffect(() => {
    setPreference(profile?.preferred_contact ?? "none");
    setAddresses(
      profile?.addresses
        .filter((address) => address.source === "portal")
        .map(({ label, recipient, contact_phone, address, is_default }) =>
          Object.freeze({ label, recipient, contact_phone, address, is_default }),
        ) ?? [],
    );
  }, [profile]);

  if (profile === null) return <p className="ld-customer-muted">个人资料暂时不可用。</p>;
  const updateAddress = (index: number, patch: Partial<PortalAddress>): void => {
    setAddresses(
      addresses.map((address, addressIndex) =>
        addressIndex === index
          ? Object.freeze({
              ...address,
              ...(patch.is_default === true ? { ...patch } : patch),
            })
          : patch.is_default === true
            ? Object.freeze({ ...address, is_default: false })
            : address,
      ),
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSave(
      Object.freeze({
        expected_version: profile.version,
        preferred_contact: preference,
        addresses,
      }),
    );
  };
  return (
    <form className="ld-customer-profile-form" onSubmit={submit}>
      <label>
        通知联系偏好
        <select
          value={preference}
          onChange={(event) =>
            setPreference(
              event.currentTarget.value as CustomerPortalProfileResult["preferred_contact"],
            )
          }
        >
          {Object.entries(contactLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="ld-customer-muted">这里只保存偏好，不代表通知服务商已经发送消息。</p>
      {storeAddresses.length === 0 ? null : (
        <ul className="ld-customer-address-list">
          {storeAddresses.map((address) => (
            <li key={address.address_id}>
              <strong>{address.label}</strong> · {address.address}
              <small>门店保存{address.is_default ? " · 默认" : ""}</small>
            </li>
          ))}
        </ul>
      )}
      {addresses.map((address, index) => (
        <fieldset key={`${profile.version}-${index}`}>
          <legend>自助地址 {index + 1}</legend>
          <label>
            标签
            <input
              value={address.label}
              maxLength={32}
              required
              onChange={(event) => updateAddress(index, { label: event.currentTarget.value })}
            />
          </label>
          <label>
            详细地址
            <input
              value={address.address}
              maxLength={256}
              required
              onChange={(event) => updateAddress(index, { address: event.currentTarget.value })}
            />
          </label>
          <label>
            收件人
            <input
              value={address.recipient ?? ""}
              maxLength={64}
              onChange={(event) =>
                updateAddress(index, { recipient: event.currentTarget.value.trim() || null })
              }
            />
          </label>
          <label>
            联系电话
            <input
              value={address.contact_phone ?? ""}
              maxLength={32}
              inputMode="tel"
              onChange={(event) =>
                updateAddress(index, { contact_phone: event.currentTarget.value.trim() || null })
              }
            />
          </label>
          <label className="ld-customer-check">
            <input
              type="checkbox"
              checked={address.is_default}
              disabled={storeHasDefault}
              onChange={(event) =>
                updateAddress(index, { is_default: event.currentTarget.checked })
              }
            />
            设为默认
          </label>
          <button
            type="button"
            onClick={() => setAddresses(addresses.filter((_, i) => i !== index))}
          >
            移除此地址
          </button>
        </fieldset>
      ))}
      <div className="ld-customer-profile-actions">
        <button
          type="button"
          disabled={addresses.length >= capacity}
          onClick={() =>
            setAddresses([
              ...addresses,
              Object.freeze({
                label: "常用地址",
                recipient: null,
                contact_phone: null,
                address: "",
                is_default: false,
              }),
            ])
          }
        >
          新增地址
        </button>
        <button type="submit" disabled={busy}>
          保存偏好
        </button>
      </div>
    </form>
  );
}

export function CustomerPortalAccount(props: CustomerPortalAccountProps) {
  return (
    <section className="ld-customer-account" aria-label="我的钱包与权益">
      <article className="ld-customer-card">
        <div className="ld-customer-section-heading">
          <h2>钱包与权益</h2>
          <button type="button" className="ld-customer-link-button" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
        <p className="ld-customer-wallet-balance">
          {props.wallet === null
            ? "尚未开通储值钱包"
            : formatCustomerPortalCents(props.wallet.balance_cents)}
        </p>
        <Benefits benefits={props.benefits} />
      </article>
      <article className="ld-customer-card">
        <h2>地址与通知偏好</h2>
        <ProfileForm {...props} />
      </article>
    </section>
  );
}
