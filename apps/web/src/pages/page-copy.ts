import type { NavItemId } from "../nav.js";

export type PageCopy = {
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  actionLabel: string;
};

const COPY: Record<NavItemId, PageCopy> = {
  workbench: {
    title: "工作台",
    emptyTitle: "今日暂无待办",
    emptyDescription: "开单或取衣后，看板与清单会出现在这里。",
    actionLabel: "去开单",
  },
  receive: {
    title: "开单",
    emptyTitle: "登录后开单",
    emptyDescription: "会话就绪后可在此录入衣物明细与整数分收款。",
    actionLabel: "去设置",
  },
  pickup: {
    title: "取衣",
    emptyTitle: "登录后取衣",
    emptyDescription: "会话就绪后按订单 UUID 取件；件 ID 可留空取全部。",
    actionLabel: "去开单",
  },
  fulfillment: {
    title: "生产",
    emptyTitle: "生产工作台不可用",
    emptyDescription: "需要开启履约功能并保持本地服务连接。",
    actionLabel: "返回工作台",
  },
  orders: {
    title: "订单与欠款",
    emptyTitle: "暂无欠款订单",
    emptyDescription: "载入后可查看仍有余额的订单，并在详情里补缴或撤销。",
    actionLabel: "去开单",
  },
  customers: {
    title: "客户",
    emptyTitle: "还没有客户",
    emptyDescription: "开单时录入手机号会自动建档（种子号段 13800000xxx）。",
    actionLabel: "新建客户",
  },
  stats: {
    title: "账目 / 对账",
    emptyTitle: "暂无对账快照",
    emptyDescription: "有业务数据后显示账本、交班、打印与离线同步证据。",
    actionLabel: "查看工作台",
  },
  settings: {
    title: "设置",
    emptyTitle: "设置项即将接入",
    emptyDescription: "最低消费等 R5 项已接 step-up PIN 复核；其余价目/打印在 M2 扩展。",
    actionLabel: "返回工作台",
  },
};

export function pageCopy(id: NavItemId): PageCopy {
  return COPY[id];
}
