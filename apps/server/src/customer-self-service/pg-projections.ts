import type {
  CustomerPortalBenefitsResult,
  CustomerPortalProfileResult,
  CustomerPortalWalletResult,
} from "@laundry/contracts";

import type { PgPoolClient } from "../db/pg-pool.js";

const integer = (value: string | number, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid ${label}`);
  return parsed;
};
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

type WalletRow = Readonly<{
  account_id: string;
  account_status: "active" | "frozen" | "closed";
  principal_cents: string | number;
  bonus_cents: string | number;
  balance_cents: string | number;
}>;

export async function readPortalWallet(client: PgPoolClient): Promise<CustomerPortalWalletResult> {
  const wallet = await client.query<WalletRow>(
    `SELECT account_id::text, account_status, principal_cents::text,
            bonus_cents::text, balance_cents::text
       FROM customer_portal_wallet LIMIT 1`,
  );
  const row = wallet.rows[0];
  if (row === undefined) return Object.freeze({ wallet: null });
  const ledger = await client.query<
    CustomerPortalWalletResult["wallet"] extends infer Wallet
      ? Wallet extends { recent: readonly (infer Entry)[] }
        ? Entry
        : never
      : never
  >(
    `SELECT ledger_id::text, kind, principal_delta_cents::text,
            bonus_delta_cents::text, order_id::text, business_date, at
       FROM customer_portal_wallet_ledger
      WHERE account_id = $1::uuid ORDER BY at DESC, ledger_id DESC LIMIT 50`,
    [row.account_id],
  );
  return Object.freeze({
    wallet: Object.freeze({
      account_status: row.account_status,
      principal_cents: integer(row.principal_cents, "wallet principal"),
      bonus_cents: integer(row.bonus_cents, "wallet bonus"),
      balance_cents: integer(row.balance_cents, "wallet balance"),
      recent: Object.freeze(
        ledger.rows.map((entry) =>
          Object.freeze({
            ...entry,
            principal_delta_cents: integer(entry.principal_delta_cents, "principal delta"),
            bonus_delta_cents: integer(entry.bonus_delta_cents, "bonus delta"),
            at: iso(entry.at),
          }),
        ),
      ),
    }),
  });
}

type BenefitAccountRow = Readonly<{
  account_id: string;
  account_status: "active" | "frozen" | "closed";
}>;
type Tier = NonNullable<NonNullable<CustomerPortalBenefitsResult["benefits"]>["tier"]>;
type Punch = NonNullable<CustomerPortalBenefitsResult["benefits"]>["punch_cards"][number];
type Coupon = NonNullable<CustomerPortalBenefitsResult["benefits"]>["coupons"][number];

export async function readPortalBenefits(
  client: PgPoolClient,
): Promise<CustomerPortalBenefitsResult> {
  const account = await client.query<BenefitAccountRow>(
    "SELECT account_id::text, account_status FROM customer_portal_wallet LIMIT 1",
  );
  const row = account.rows[0];
  if (row === undefined) return Object.freeze({ benefits: null });
  const [tier, points, cards, coupons] = await Promise.all([
    client.query<Tier>(
      `SELECT name, level, valid_until::text, status FROM customer_portal_membership
        WHERE account_id = $1::uuid LIMIT 1`,
      [row.account_id],
    ),
    client.query<{ available_points: string | number }>(
      `SELECT available_points::text FROM customer_portal_points
        WHERE account_id = $1::uuid LIMIT 1`,
      [row.account_id],
    ),
    client.query<Punch>(
      `SELECT asset_id::text, name, total_uses, used_uses, remaining_uses,
              expires_on::text, status FROM customer_portal_punch_cards
        ORDER BY expires_on, asset_id LIMIT 50`,
    ),
    client.query<Coupon>(
      `SELECT asset_id::text, name, discount_cents, min_order_cents,
              expires_on::text, status FROM customer_portal_coupons
        ORDER BY expires_on, asset_id LIMIT 50`,
    ),
  ]);
  return Object.freeze({
    benefits: Object.freeze({
      account_status: row.account_status,
      tier: tier.rows[0] === undefined ? null : Object.freeze({ ...tier.rows[0] }),
      available_points: integer(points.rows[0]?.available_points ?? 0, "available points"),
      punch_cards: Object.freeze(cards.rows.map((card) => Object.freeze({ ...card }))),
      coupons: Object.freeze(coupons.rows.map((coupon) => Object.freeze({ ...coupon }))),
    }),
  });
}

type PreferenceRow = Pick<CustomerPortalProfileResult, "version" | "preferred_contact">;
type AddressRow = CustomerPortalProfileResult["addresses"][number];

export async function readPortalProfile(
  client: PgPoolClient,
): Promise<CustomerPortalProfileResult | null> {
  const preference = await client.query<PreferenceRow>(
    "SELECT version, preferred_contact FROM customer_portal_profile_preference LIMIT 1",
  );
  if (preference.rows[0] === undefined) return null;
  const addresses = await client.query<AddressRow>(
    `SELECT address_id::text, label, recipient, contact_phone, address,
            is_default, source FROM customer_portal_addresses
      ORDER BY is_default DESC, created_at, address_id LIMIT 11`,
  );
  if (addresses.rows.length > 10) throw new TypeError("Customer portal address bound exceeded");
  return Object.freeze({
    ...preference.rows[0],
    addresses: Object.freeze(addresses.rows.map((address) => Object.freeze({ ...address }))),
  });
}
