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
    emptyDescription: "会话就绪后可在此录入衣物明细，并按元录入收款金额。",
    actionLabel: "去设置",
  },
  pickup: {
    title: "取衣",
    emptyTitle: "登录后取衣",
    emptyDescription: "登录后可扫描取件码，或按票号、手机号查找订单并核对衣物。",
    actionLabel: "去开单",
  },
  delivery: {
    title: "取送订单",
    emptyTitle: "取送订单不可用",
    emptyDescription: "需要登录并保持本地服务连接，既有在途订单不会因功能关闭而隐藏。",
    actionLabel: "返回工作台",
  },
  fulfillment: {
    title: "生产",
    emptyTitle: "生产工作台不可用",
    emptyDescription: "需要开启履约功能并保持本地服务连接。",
    actionLabel: "返回工作台",
  },
  orders: {
    title: "订单与欠款",
    emptyTitle: "登录后查询订单",
    emptyDescription: "可按票号、客户、日期与状态查询全部订单、欠款和待取衣物。",
    actionLabel: "去开单",
  },
  customers: {
    title: "客户",
    emptyTitle: "还没有客户",
    emptyDescription: "开单时录入手机号可建立客户档案，也可在此新增与查询客户。",
    actionLabel: "新建客户",
  },
  reminders: {
    title: "催取工作台",
    emptyTitle: "催取工作台不可用",
    emptyDescription: "请登录并保持本地服务连接；发送短信前需配置门店短信服务并核对发送范围。",
    actionLabel: "返回工作台",
  },
  stats: {
    title: "账目 / 对账",
    emptyTitle: "暂无对账快照",
    emptyDescription: "有业务数据后显示账本、交班、打印与离线同步证据。",
    actionLabel: "查看工作台",
  },
  settings: {
    title: "设置",
    emptyTitle: "登录后查看门店设置",
    emptyDescription: "可配置价目、计价、员工权限及服务接入；重要修改需按门店权限复核。",
    actionLabel: "返回工作台",
  },
};

export function pageCopy(id: NavItemId): PageCopy {
  return COPY[id];
}
