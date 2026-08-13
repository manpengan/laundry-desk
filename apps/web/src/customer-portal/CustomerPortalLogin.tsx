import { useState, type FormEvent } from "react";

import type { CustomerPortalLoginInput } from "@laundry/contracts";

export type CustomerPortalLoginProps = Readonly<{
  busy: boolean;
  error: string | null;
  onLogin(input: CustomerPortalLoginInput): Promise<void>;
}>;

export function CustomerPortalLogin({ busy, error, onLogin }: CustomerPortalLoginProps) {
  const [orgCode, setOrgCode] = useState("");
  const [storeCode, setStoreCode] = useState("");
  const [phone, setPhone] = useState("");
  const [pickupCode, setPickupCode] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onLogin(
      Object.freeze({
        org_code: orgCode.trim(),
        store_code: storeCode.trim(),
        phone: phone.trim(),
        pickup_code: pickupCode.trim(),
      }),
    );
  };

  return (
    <main className="ld-customer-portal ld-customer-login">
      <section className="ld-customer-card ld-customer-login-card" aria-labelledby="portal-login">
        <p className="ld-customer-eyebrow">洗护进度自助查询</p>
        <h1 id="portal-login">查看我的订单</h1>
        <p className="ld-customer-muted">使用门店信息、手机号和取件码验证身份。</p>
        <form onSubmit={submit} className="ld-customer-form">
          <label>
            商户代码
            <input
              value={orgCode}
              onChange={(event) => setOrgCode(event.currentTarget.value)}
              autoComplete="organization"
              maxLength={64}
              required
            />
          </label>
          <label>
            门店代码
            <input
              value={storeCode}
              onChange={(event) => setStoreCode(event.currentTarget.value)}
              maxLength={64}
              required
            />
          </label>
          <label>
            手机号
            <input
              value={phone}
              onChange={(event) => setPhone(event.currentTarget.value)}
              inputMode="tel"
              autoComplete="tel"
              maxLength={11}
              required
            />
          </label>
          <label>
            取件码
            <input
              value={pickupCode}
              onChange={(event) => setPickupCode(event.currentTarget.value)}
              autoCapitalize="off"
              maxLength={64}
              required
            />
          </label>
          {error === null ? null : (
            <p className="ld-customer-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "正在验证…" : "安全查询"}
          </button>
        </form>
        <p className="ld-customer-privacy">验证失败不会说明哪一项信息不正确。</p>
      </section>
    </main>
  );
}
