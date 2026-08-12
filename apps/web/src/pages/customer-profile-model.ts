import {
  CustomerDiscountPolicySetInputSchema,
  CustomerProfileResultSchema,
  CustomerProfileSetInputSchema,
  type CustomerProfileResult,
} from "@laundry/contracts";

export type CustomerProfileView = Readonly<
  Omit<CustomerProfileResult, "waivers" | "addresses" | "identifiers">
> &
  Readonly<{
    waivers: Readonly<CustomerProfileResult["waivers"]>;
    addresses: readonly Readonly<CustomerProfileResult["addresses"][number]>[];
    identifiers: readonly Readonly<CustomerProfileResult["identifiers"][number]>[];
  }>;
export type CustomerAddressDraft = Readonly<{
  key: string;
  label: string;
  recipient: string;
  contact_phone: string;
  address: string;
  is_default: boolean;
}>;
export type CustomerIdentifierDraft = Readonly<{
  key: string;
  kind: "vehicle_plate" | "tag" | "external_ref";
  value: string;
}>;
export type CustomerProfileDraft = Readonly<{
  gender: "unspecified" | "female" | "male" | "other";
  preferred_contact: "none" | "phone" | "sms" | "wechat";
  service_note: string;
  waivers: Readonly<{
    skip_ticket_print: boolean;
    skip_label_print: boolean;
    skip_rack_assignment: boolean;
  }>;
  addresses: readonly CustomerAddressDraft[];
  identifiers: readonly CustomerIdentifierDraft[];
  reason: string;
}>;

export type DiscountMode = "inherit" | "disabled" | "customer";

export type BuildProfileBodyResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapResult(value: unknown): unknown {
  const row = record(value);
  return row !== null && "result" in row ? row.result : value;
}

function freezeProfile(profile: CustomerProfileResult): CustomerProfileView {
  return Object.freeze({
    ...profile,
    waivers: Object.freeze({ ...profile.waivers }),
    addresses: Object.freeze(profile.addresses.map((address) => Object.freeze({ ...address }))),
    identifiers: Object.freeze(
      profile.identifiers.map((identifier) => Object.freeze({ ...identifier })),
    ),
  });
}

export function parseCustomerProfile(value: unknown): CustomerProfileView | null {
  const parsed = CustomerProfileResultSchema.safeParse(unwrapResult(value));
  return parsed.success ? freezeProfile(parsed.data) : null;
}

export function profileDraftFromView(profile: CustomerProfileView): CustomerProfileDraft {
  return Object.freeze({
    gender: profile.gender,
    preferred_contact: profile.preferred_contact,
    service_note: profile.service_note ?? "",
    waivers: Object.freeze({ ...profile.waivers }),
    addresses: Object.freeze(
      profile.addresses.map((address) =>
        Object.freeze({
          key: address.address_id,
          label: address.label,
          recipient: address.recipient ?? "",
          contact_phone: address.contact_phone ?? "",
          address: address.address,
          is_default: address.is_default,
        }),
      ),
    ),
    identifiers: Object.freeze(
      profile.identifiers.map((identifier) =>
        Object.freeze({
          key: identifier.identifier_id,
          kind: identifier.kind,
          value: identifier.value,
        }),
      ),
    ),
    reason: "",
  });
}

function issueMessage(
  issues: readonly Readonly<{ path: PropertyKey[]; message: string }>[],
): string {
  const issue = issues[0];
  if (issue === undefined) return "档案输入无效";
  const field = issue.path.length === 0 ? "档案" : issue.path.join(".");
  return `${field}：${issue.message}`;
}

export function buildCustomerProfileBody(
  customerId: string,
  expectedVersion: number,
  draft: CustomerProfileDraft,
): BuildProfileBodyResult {
  const candidate = {
    customer_id: customerId,
    expected_version: expectedVersion,
    gender: draft.gender,
    preferred_contact: draft.preferred_contact,
    service_note: draft.service_note.trim() || null,
    waivers: { ...draft.waivers },
    addresses: draft.addresses.map((address) => ({
      label: address.label,
      recipient: address.recipient.trim() || null,
      contact_phone: address.contact_phone.trim() || null,
      address: address.address,
      is_default: address.is_default,
    })),
    identifiers: draft.identifiers.map((identifier) => ({
      kind: identifier.kind,
      value: identifier.value,
    })),
    reason: draft.reason,
  };
  const parsed = CustomerProfileSetInputSchema.safeParse(candidate);
  return parsed.success
    ? Object.freeze({ ok: true as const, body: Object.freeze(parsed.data) })
    : Object.freeze({ ok: false as const, message: issueMessage(parsed.error.issues) });
}

export function discountModeFor(bps: number | null): DiscountMode {
  return bps === null ? "inherit" : bps === 0 ? "disabled" : "customer";
}

export function formatDiscountPercent(bps: number): string {
  return (bps / 100)
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.\d)0$/u, "$1");
}

function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/u.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(bps) && bps >= 1 && bps <= 10_000 ? bps : null;
}

export function buildCustomerDiscountBody(
  customerId: string,
  expectedVersion: number,
  mode: DiscountMode,
  percent: string,
  reason: string,
): BuildProfileBodyResult {
  const discountBps = mode === "inherit" ? null : mode === "disabled" ? 0 : parsePercent(percent);
  if (discountBps === null && mode === "customer") {
    return Object.freeze({
      ok: false as const,
      message: "顾客专属折扣须为 0.01–100，最多两位小数",
    });
  }
  const parsed = CustomerDiscountPolicySetInputSchema.safeParse({
    customer_id: customerId,
    expected_version: expectedVersion,
    discount_bps: discountBps,
    reason,
  });
  return parsed.success
    ? Object.freeze({ ok: true as const, body: Object.freeze(parsed.data) })
    : Object.freeze({ ok: false as const, message: issueMessage(parsed.error.issues) });
}
