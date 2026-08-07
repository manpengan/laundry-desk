import {
  groupPickupReminders,
  renderPickupReminder,
  type PickupReminderGroupBy,
} from "@laundry/domain";

export type PickupReminderStatus = "ready" | "racked";

export type PickupReminderView = Readonly<{
  order_id: string;
  ticket_no: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string;
  garment_count: number;
  balance_cents: number;
  received_at: string;
  overdue_days: number;
  garment_statuses: readonly PickupReminderStatus[];
  last_contact_at: string | null;
}>;

export type PickupReminderListView = Readonly<{
  generated_at: string;
  channels: Readonly<{ manual: true; sms: false; wechat: false }>;
  candidates: readonly PickupReminderView[];
}>;

export type ManualListResultView = Readonly<{
  batch_id: string;
  generated_at: string;
  channel: "manual";
  status: "list_generated";
  cost_cents: 0;
  recipient_count: number;
  order_count: number;
  filename: string;
  content_sha256: string;
  csv: string;
  rows: readonly Readonly<{
    order_ids: readonly string[];
    ticket_nos: readonly string[];
    customer_name: string | null;
    customer_phone: string;
    garment_count: number;
    balance_cents: number;
    message: string;
  }>[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
  );
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value);
}

function parseCandidate(value: unknown): PickupReminderView | null {
  if (
    !isRecord(value) ||
    typeof value.order_id !== "string" ||
    typeof value.ticket_no !== "string" ||
    (value.customer_id !== null && typeof value.customer_id !== "string") ||
    (value.customer_name !== null && typeof value.customer_name !== "string") ||
    typeof value.customer_phone !== "string" ||
    !/^1[3-9]\d{9}$/u.test(value.customer_phone) ||
    !isInteger(value.garment_count, true) ||
    !isInteger(value.balance_cents) ||
    !isIso(value.received_at) ||
    !isInteger(value.overdue_days) ||
    !Array.isArray(value.garment_statuses) ||
    value.garment_statuses.length === 0 ||
    value.garment_statuses.some((status) => status !== "ready" && status !== "racked") ||
    (value.last_contact_at !== null && !isIso(value.last_contact_at))
  ) {
    return null;
  }
  return Object.freeze({
    order_id: value.order_id,
    ticket_no: value.ticket_no,
    customer_id: value.customer_id,
    customer_name: value.customer_name,
    customer_phone: value.customer_phone,
    garment_count: value.garment_count,
    balance_cents: value.balance_cents,
    received_at: value.received_at,
    overdue_days: value.overdue_days,
    garment_statuses: Object.freeze([...value.garment_statuses] as PickupReminderStatus[]),
    last_contact_at: value.last_contact_at,
  });
}

export function parsePickupReminderList(value: unknown): PickupReminderListView | null {
  if (
    !isRecord(value) ||
    !isIso(value.generated_at) ||
    !isRecord(value.channels) ||
    value.channels.manual !== true ||
    value.channels.sms !== false ||
    value.channels.wechat !== false ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 200
  ) {
    return null;
  }
  const candidates = value.candidates.map(parseCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  return Object.freeze({
    generated_at: value.generated_at,
    channels: Object.freeze({ manual: true, sms: false, wechat: false }),
    candidates: Object.freeze(candidates as PickupReminderView[]),
  });
}

function parseManualRow(value: unknown): ManualListResultView["rows"][number] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.order_ids) ||
    value.order_ids.length === 0 ||
    value.order_ids.some((id) => typeof id !== "string") ||
    !Array.isArray(value.ticket_nos) ||
    value.ticket_nos.length === 0 ||
    value.ticket_nos.some((ticket) => typeof ticket !== "string") ||
    (value.customer_name !== null && typeof value.customer_name !== "string") ||
    typeof value.customer_phone !== "string" ||
    !isInteger(value.garment_count, true) ||
    !isInteger(value.balance_cents) ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    order_ids: Object.freeze([...value.order_ids] as string[]),
    ticket_nos: Object.freeze([...value.ticket_nos] as string[]),
    customer_name: value.customer_name,
    customer_phone: value.customer_phone,
    garment_count: value.garment_count,
    balance_cents: value.balance_cents,
    message: value.message,
  });
}

export function parseManualListResult(value: unknown): ManualListResultView | null {
  if (
    !isRecord(value) ||
    typeof value.batch_id !== "string" ||
    !isIso(value.generated_at) ||
    value.channel !== "manual" ||
    value.status !== "list_generated" ||
    value.cost_cents !== 0 ||
    !isInteger(value.recipient_count, true) ||
    !isInteger(value.order_count, true) ||
    typeof value.filename !== "string" ||
    typeof value.content_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.content_sha256) ||
    typeof value.csv !== "string" ||
    !Array.isArray(value.rows)
  ) {
    return null;
  }
  const rows = value.rows.map(parseManualRow);
  if (rows.some((row) => row === null) || rows.length !== value.recipient_count) return null;
  return Object.freeze({
    batch_id: value.batch_id,
    generated_at: value.generated_at,
    channel: "manual",
    status: "list_generated",
    cost_cents: 0,
    recipient_count: value.recipient_count,
    order_count: value.order_count,
    filename: value.filename,
    content_sha256: value.content_sha256,
    csv: value.csv,
    rows: Object.freeze(rows as ManualListResultView["rows"][number][]),
  });
}

export function previewPickupReminderMessages(
  candidates: readonly PickupReminderView[],
  selectedIds: ReadonlySet<string>,
  groupBy: PickupReminderGroupBy,
  template: string,
) {
  return groupPickupReminders(
    candidates.filter((candidate) => selectedIds.has(candidate.order_id)),
    groupBy,
  ).map((group) => Object.freeze({ ...group, message: renderPickupReminder(template, group) }));
}
