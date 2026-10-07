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
import {
  SETTINGS_GROUPS,
  SETTINGS_KEYWORDS,
  isAdvancedSection,
  readSettingsSection,
  saveSettingsSection,
} from "./settings-navigation.js";
type SettingsLayoutProps = Readonly<{
  sections: readonly SettingsSection[];
  session: SessionView;
  authClient: AuthClient;
  queryClient?: QueryPort | undefined;
}>;
export function SettingsLayout(props: SettingsLayoutProps) {
  const { session } = props.session;
  const workspaceKey = JSON.stringify([
    session.session_id,
    session.session_version,
    session.org_id,
    session.store_id,
    session.staff_id,
    session.device_id,
    session.permission_version,
    props.session.role,
    props.sections.map((section) => section.id),
  ]);
  return <SettingsWorkspace key={workspaceKey} {...props} />;
}
function matchesSearch(section: SettingsSection, query: string): boolean {
  return `${section.label} ${SETTINGS_KEYWORDS[section.id] ?? ""}`
    .toLocaleLowerCase()
    .includes(query);
}
function SettingsWorkspace({ sections, session, authClient, queryClient }: SettingsLayoutProps) {
  // Resolve the permitted preference before mounting any panel or starting its reads.
  const [initialPreference] = useState(() =>
    readSettingsSection(sections.map((section) => section.id)),
  );
  const [selected, setSelected] = useState(initialPreference.selected);
  const [preferenceError, setPreferenceError] = useState(initialPreference.error);
  const [advancedOpen, setAdvancedOpen] = useState(isAdvancedSection(initialPreference.selected));
  const [visited, setVisited] = useState<readonly string[]>(() =>
    initialPreference.selected === "" ? [] : [initialPreference.selected],
  );
  const [search, setSearch] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const matching = sections.filter((section) => matchesSearch(section, query));
  const visit = (ids: readonly string[]) => {
    setVisited((previous) => [...new Set([...previous, ...ids])]);
  };
  const select = (id: string) => {
    if (id !== "" && !sections.some((section) => section.id === id)) return;
    setSearch("");
    setSelected(id);
    visit(id === "" ? sections.map((section) => section.id) : [id]);
    if (id !== "") {
      setPreferenceError(saveSettingsSection(id));
      if (isAdvancedSection(id)) setAdvancedOpen(true);
    }
    // Already visited panels stay mounted so narrowing settings preserves edited forms.
    requestAnimationFrame(() => {
      const target = content.current;
      if (!target) return;
      const header = target.closest(".ld-shell")?.querySelector(".ld-shell-topbar");
      // The sticky header wraps on narrow windows; its desktop height is not a safe offset.
      if (header) target.style.scrollMarginTop = `${header.getBoundingClientRect().height + 16}px`;
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
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
      {preferenceError === null ? null : <p role="status">{preferenceError}</p>}
      <div className="ld-settings-layout">
        <nav className="ld-settings-nav" aria-label="设置分区">
          <Input
            name="settings-search"
            label="搜索设置"
            placeholder="如：价目、短信、主题"
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              const nextQuery = value.trim().toLocaleLowerCase();
              setSearch(value);
              if (nextQuery !== "") {
                visit(
                  sections
                    .filter((section) => matchesSearch(section, nextQuery))
                    .map((section) => section.id),
                );
              }
            }}
          />
          <label className="ld-settings-mobile-select ld-field">
            <span className="ld-field__label">查看分区</span>
            <select
              className="ld-select ld-input"
              value={query.length > 0 ? "" : selected}
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
            <Button
              variant="ghost"
              aria-expanded={advancedOpen || query.length > 0}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              高级设置
            </Button>
            {SETTINGS_GROUPS.map((group) => {
              const items = matching.filter((section) =>
                group.ids.some((id) => section.id === `settings-${id}`),
              );
              return items.length === 0 ? null : (
                <div
                  key={group.label}
                  className="ld-settings-nav__group"
                  hidden={group.advanced && !advancedOpen && query.length === 0}
                >
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
          {query.length === 0 && selected !== "" ? (
            <p className="ld-settings-selection-hint">
              当前分区：{sections.find((section) => section.id === selected)?.label}
              。切换分区会保留未保存的编辑。
            </p>
          ) : null}
          {matching.length === 0 ? <p role="status">没有找到相关设置，请换一个关键词。</p> : null}
          {sections.map((section) => (
            <div
              key={section.id}
              id={section.id}
              className="ld-settings-anchor"
              hidden={
                !matching.includes(section) ||
                (query.length === 0 && selected !== "" && selected !== section.id)
              }
            >
              {visited.includes(section.id) ? section.content : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
