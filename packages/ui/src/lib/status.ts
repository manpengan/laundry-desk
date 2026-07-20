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

const garment: Record<string, StatusDescriptor> = {
  received: { tone: "busy", shape: "ring", label: "已收衣" },
  washing: { tone: "busy", shape: "diamond", label: "洗涤中" },
  hanging: { tone: "ok", shape: "circle", label: "已上挂" },
  ready: { tone: "ok", shape: "circle", label: "待取" },
  delivered: { tone: "neutral", shape: "square", label: "已取" },
  rework: { tone: "warn", shape: "triangle", label: "返工" },
  lost: { tone: "danger", shape: "square", label: "丢失" },
};

const order: Record<string, StatusDescriptor> = {
  open: { tone: "busy", shape: "ring", label: "进行中" },
  partial: { tone: "warn", shape: "triangle", label: "部分取" },
  closed: { tone: "neutral", shape: "square", label: "已结" },
  voided: { tone: "danger", shape: "square", label: "已撤" },
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
