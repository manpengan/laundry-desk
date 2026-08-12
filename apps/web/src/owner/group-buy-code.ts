import { MarketingGroupBuyVoucherCodeSchema } from "@laundry/contracts";

const GROUP_BUY_DIGEST_DOMAIN = "laundry:group-buy:v1\u0000";

export type PreparedGroupBuyCode = Readonly<{
  digest: string;
  last4: string;
}>;

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate locally so the bearer code itself never crosses the command boundary. */
export async function prepareGroupBuyCode(raw: string): Promise<PreparedGroupBuyCode | null> {
  const parsed = MarketingGroupBuyVoucherCodeSchema.safeParse(raw);
  if (!parsed.success || globalThis.crypto?.subtle === undefined) return null;
  const code = parsed.data;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${GROUP_BUY_DIGEST_DOMAIN}${code}`),
  );
  return Object.freeze({ digest: bytesToHex(digest), last4: code.slice(-4) });
}
