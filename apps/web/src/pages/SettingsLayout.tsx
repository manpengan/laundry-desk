import { Button, cn, Icon, Input, type IconName } from "@laundry/ui";
import { useRef, useState, type ReactNode } from "react";
import { StoreSetupChecklist } from "./StoreSetupChecklist.js";
import type { AuthClient } from "../auth/AuthClient.js";
import type { QueryPort } from "../commands/types.js";
import type { SessionView } from "../auth/types.js";

export type SettingsSection = Readonly<{
  id: string;
  label: string;
  icon: IconName;
  content: ReactNode;
}>;
const GROUPS = [
  { label: "营业设置", ids: ["catalog", "pricing", "delivery", "member", "payments", "staff"] },
  {
    label: "设备与数据",
    ids: ["appearance", "offline", "printer", "store-export", "migration", "support"],
  },
  {
    label: "服务接入",
    ids: ["notification", "ai", "miniapp", "miniapp-notifications", "remote-assistance"],
  },
] as const;
const KEYWORDS: Readonly<Record<string, string>> = {
  "settings-catalog": "衣物 价格 单价 模板",
  "settings-pricing": "加急 运费 附加 折扣",
  "settings-appearance": "深色 浅色 主题 字体",
  "settings-notification": "短信 通知 阿里云",
  "settings-staff": "店员 店长 复核 账号",
  "settings-payments": "微信 支付宝 收款 商户",
};
export function SettingsLayout({
  sections,
  session,
  authClient,
  queryClient,
}: Readonly<{
  sections: readonly SettingsSection[];
  session: SessionView;
  authClient: AuthClient;
  queryClient?: QueryPort | undefined;
}>) {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const matching = sections.filter((section) =>
    `${section.label} ${KEYWORDS[section.id] ?? ""}`.toLocaleLowerCase().includes(query),
  );
  const select = (id: string) => {
    setSearch("");
    setSelected(id);
    // Keep every panel mounted so narrowing settings never discards an edited form.
    requestAnimationFrame(() => {
      content.current?.scrollIntoView({ block: "start" });
      content.current?.focus({ preventScroll: true });
    });
  };
  return (
    <>
      {session.role === "admin" && queryClient ? (
        <StoreSetupChecklist
          queryClient={queryClient}
          authClient={authClient}
          session={session}
          onSelect={select}
        />
      ) : null}
      <div className="ld-settings-layout">
        <nav className="ld-settings-nav" aria-label="设置分区">
          <Input
            name="settings-search"
            label="搜索设置"
            placeholder="如：价目、短信、主题"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected("");
            }}
          />
          <label className="ld-settings-mobile-select ld-field">
            <span className="ld-field__label">查看分区</span>
            <select
              className="ld-select ld-input"
              value={selected}
              onChange={(event) => select(event.target.value)}
            >
              <option value="">全部设置</option>
              {matching.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ld-settings-desktop-nav">
            <Button variant="ghost" onClick={() => select("")}>
              查看全部设置
            </Button>
            {GROUPS.map((group) => {
              const items = matching.filter((section) =>
                group.ids.some((id) => section.id === `settings-${id}`),
              );
              return items.length === 0 ? null : (
                <div key={group.label} className="ld-settings-nav__group">
                  <h2>{group.label}</h2>
                  {items.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className={cn(
                        "ld-settings-nav__item",
                        selected === section.id && "is-active",
                      )}
                      aria-current={selected === section.id ? "true" : undefined}
                      onClick={() => select(section.id)}
                    >
                      <Icon name={section.icon} size={18} />
                      {section.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </nav>
        <div ref={content} className="ld-settings-content" tabIndex={-1} aria-label="设置内容">
          {matching.length === 0 ? <p role="status">没有找到相关设置，请换一个关键词。</p> : null}
          {sections.map((section) => (
            <div
              key={section.id}
              id={section.id}
              className="ld-settings-anchor"
              hidden={!matching.includes(section) || (selected !== "" && selected !== section.id)}
            >
              {section.content}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
