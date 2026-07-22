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
    emptyTitle: "还没有价目",
    emptyDescription: "先在设置里维护品类与价格，再开始收衣。",
    actionLabel: "去设置",
  },
  pickup: {
    title: "取衣",
    emptyTitle: "没有待取件",
    emptyDescription: "扫码或输入取件码后，会在此载入件级清单。",
    actionLabel: "输入取件码",
  },
  customers: {
    title: "客户",
    emptyTitle: "还没有客户",
    emptyDescription: "开单时录入手机号会自动建档（种子号段 13800000xxx）。",
    actionLabel: "新建客户",
  },
  stats: {
    title: "统计",
    emptyTitle: "暂无汇总",
    emptyDescription: "有业务数据后显示今日收衣/取衣与营业额。",
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
