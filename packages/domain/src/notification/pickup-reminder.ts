export const DEFAULT_PICKUP_REMINDER_TEMPLATE =
  "您好，您的洗衣订单{{tickets}}共{{garment_count}}件已可取，尚欠{{balance_cents}}分，请方便时到店取衣。";

export const PICKUP_REMINDER_PLACEHOLDERS = Object.freeze([
  "{{tickets}}",
  "{{garment_count}}",
  "{{balance_cents}}",
] as const);

export type PickupReminderGroupBy = "order" | "customer";

export type PickupReminderCandidateLike = Readonly<{
  order_id: string;
  ticket_no: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string;
  garment_count: number;
  balance_cents: number;
}>;

export type PickupReminderGroup = Readonly<{
  key: string;
  order_ids: readonly string[];
  ticket_nos: readonly string[];
  customer_name: string | null;
  customer_phone: string;
  garment_count: number;
  balance_cents: number;
}>;

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Pickup reminder totals must remain non-negative safe integers");
  }
  return value;
}

function customerGroupKey(candidate: PickupReminderCandidateLike): string {
  const identity = candidate.customer_id ?? `phone:${candidate.customer_phone}`;
  // A customer can have old order snapshots with a superseded number. Never
  // collapse two phone targets into one recipient merely because ids match.
  return `customer:${identity}:${candidate.customer_phone}`;
}

function validateCandidate(candidate: PickupReminderCandidateLike): void {
  if (
    !Number.isSafeInteger(candidate.garment_count) ||
    candidate.garment_count <= 0 ||
    !Number.isSafeInteger(candidate.balance_cents) ||
    candidate.balance_cents < 0
  ) {
    throw new RangeError("Pickup reminder candidate totals are invalid");
  }
}

export function groupPickupReminders(
  candidates: readonly PickupReminderCandidateLike[],
  groupBy: PickupReminderGroupBy,
): readonly PickupReminderGroup[] {
  const grouped = new Map<string, PickupReminderGroup>();

  for (const candidate of candidates) {
    validateCandidate(candidate);
    const key = groupBy === "order" ? `order:${candidate.order_id}` : customerGroupKey(candidate);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(
        key,
        Object.freeze({
          key,
          order_ids: Object.freeze([candidate.order_id]),
          ticket_nos: Object.freeze([candidate.ticket_no]),
          customer_name: candidate.customer_name,
          customer_phone: candidate.customer_phone,
          garment_count: candidate.garment_count,
          balance_cents: candidate.balance_cents,
        }),
      );
      continue;
    }
    grouped.set(
      key,
      Object.freeze({
        ...current,
        order_ids: Object.freeze([...current.order_ids, candidate.order_id]),
        ticket_nos: Object.freeze([...current.ticket_nos, candidate.ticket_no]),
        customer_name: current.customer_name ?? candidate.customer_name,
        garment_count: addSafe(current.garment_count, candidate.garment_count),
        balance_cents: addSafe(current.balance_cents, candidate.balance_cents),
      }),
    );
  }

  return Object.freeze([...grouped.values()]);
}

export function isPickupReminderTemplate(template: string): boolean {
  const trimmed = template.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  const remainder = trimmed.replace(/\{\{(?:tickets|garment_count|balance_cents)\}\}/gu, "");
  return !remainder.match(/\{\{|\}\}/u);
}

export function renderPickupReminder(template: string, group: PickupReminderGroup): string {
  if (!isPickupReminderTemplate(template)) {
    throw new TypeError("Pickup reminder template contains an unsupported placeholder");
  }
  const values = Object.freeze({
    tickets: group.ticket_nos.join("、"),
    garment_count: String(group.garment_count),
    balance_cents: String(group.balance_cents),
  });
  return template
    .trim()
    .replace(/\{\{tickets\}\}/gu, values.tickets)
    .replace(/\{\{garment_count\}\}/gu, values.garment_count)
    .replace(/\{\{balance_cents\}\}/gu, values.balance_cents);
}
