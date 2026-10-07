import {
  readPreference,
  writePreference,
  type PreferenceStorage,
} from "./device-preference-storage.js";
const KEY = "laundry.settings.section.v1";
export const SETTINGS_GROUPS = [
  {
    label: "日常营业",
    advanced: false,
    ids: [
      "catalog",
      "pricing",
      "delivery",
      "member",
      "payments",
      "staff",
      "appearance",
      "notification",
      "backup",
    ],
  },
  {
    label: "设备与数据维护",
    advanced: true,
    ids: ["offline", "printer", "store-export", "migration", "support"],
  },
  {
    label: "扩展服务",
    advanced: true,
    ids: ["ai", "miniapp", "miniapp-notifications", "remote-assistance"],
  },
] as const;
export const SETTINGS_KEYWORDS: Readonly<Record<string, string>> = {
  "settings-catalog": "衣物 价格 单价 模板",
  "settings-pricing": "加急 运费 附加 折扣",
  "settings-appearance":
    "深色 浅色 明暗 主题 配色 字体 动效 动画 极光 玻璃 晴空 海盐 青竹 樱花 暖阳",
  "settings-notification": "短信 通知 阿里云",
  "settings-staff": "店员 店长 复核 账号",
  "settings-payments": "微信 支付宝 收款 商户",
  "settings-migration": "旧版 导入 照片 迁移",
  "settings-store-export": "备份 数据 照片 导出",
  "settings-offline": "断网 同步 冲突 队列",
};
export function readSettingsSection(ids: readonly string[], storage?: PreferenceStorage | null) {
  const preference = readPreference(KEY, storage);
  const fallback = ids.includes("settings-catalog") ? "settings-catalog" : (ids[0] ?? "");
  return {
    selected:
      typeof preference.value === "string" && ids.includes(preference.value)
        ? preference.value
        : fallback,
    error: preference.error,
  };
}
export function saveSettingsSection(id: string, storage?: PreferenceStorage | null): string | null {
  return writePreference(KEY, id, storage);
}
export function isAdvancedSection(id: string): boolean {
  return !SETTINGS_GROUPS[0].ids.some((name) => id === `settings-${name}`);
}
