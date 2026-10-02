/** Status badge: color + shape dual encoding (color-blind safe). */

export type StatusFamily = "garment" | "order" | "print" | "sync";

export type StatusTone = "ok" | "busy" | "warn" | "danger" | "neutral";

/** Glyph keys map to SVG shapes in StatusBadge */
export type StatusShape =
  | "circle" // solid disc
  | "ring" // hollow circle
  | "triangle" // warning
  | "square" // stopped / error block
  | "diamond"; // in-progress alternate

export type StatusDescriptor = {
  tone: StatusTone;
  shape: StatusShape;
  label: string;
};

// Must track FulfillmentGarmentStatusSchema and reuse the 生产 page wording, so
// the same garment reads the same on 取衣、订单详情 and 生产.
const garment: Record<string, StatusDescriptor> = {
  received: { tone: "busy", shape: "ring", label: "已收" },
  washing: { tone: "busy", shape: "diamond", label: "加工中" },
  ready: { tone: "ok", shape: "circle", label: "已完成" },
  racked: { tone: "ok", shape: "circle", label: "待取" },
  picked_up: { tone: "neutral", shape: "square", label: "已取" },
  delivered: { tone: "neutral", shape: "square", label: "已送达" },
  reworked: { tone: "warn", shape: "triangle", label: "返工" },
  lost: { tone: "danger", shape: "square", label: "丢损" },
};

// Must track OrderStatusSchema (draft | open | closed | cancelled). An unknown
// status falls back to the raw value, which would leak English into the UI.
const order: Record<string, StatusDescriptor> = {
  draft: { tone: "neutral", shape: "ring", label: "挂单" },
  open: { tone: "busy", shape: "ring", label: "进行中" },
  partial: { tone: "warn", shape: "triangle", label: "部分取" },
  closed: { tone: "neutral", shape: "square", label: "已结" },
  cancelled: { tone: "danger", shape: "square", label: "已撤销" },
};

const print: Record<string, StatusDescriptor> = {
  queued: { tone: "busy", shape: "ring", label: "排队" },
  printing: { tone: "busy", shape: "diamond", label: "打印中" },
  done: { tone: "ok", shape: "circle", label: "已出票" },
  failed: { tone: "danger", shape: "square", label: "失败" },
};

const sync: Record<string, StatusDescriptor> = {
  online: { tone: "ok", shape: "circle", label: "在线" },
  offline: { tone: "warn", shape: "triangle", label: "离线" },
  pending: { tone: "busy", shape: "diamond", label: "待同步" },
  error: { tone: "danger", shape: "square", label: "同步失败" },
};

const catalogs: Record<StatusFamily, Record<string, StatusDescriptor>> = {
  garment,
  order,
  print,
  sync,
};

export function resolveStatus(family: StatusFamily, status: string): StatusDescriptor {
  const hit = catalogs[family][status];
  if (hit) return hit;
  return { tone: "neutral", shape: "ring", label: status || "未知" };
}
