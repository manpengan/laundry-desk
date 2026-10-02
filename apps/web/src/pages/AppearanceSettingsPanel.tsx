/** 设置 → 外观与快捷键: device-local theme + the shortcut reference. */

import { Kbd, Tabs } from "@laundry/ui";
import { Fragment } from "react";

import { COUNTER_SHORTCUTS } from "../shell/ShortcutHelpDialog.js";
import { useThemeControl } from "../shell/shell-shortcuts.js";
import { THEME_PREFERENCES, themePreferenceLabel, type ThemePreference } from "../theme.js";

export function AppearanceSettingsPanel() {
  const theme = useThemeControl();
  return (
    <section className="ld-settings-section lg-card" aria-label="外观与快捷键">
      <header className="ld-settings-section__head">
        <h2>外观与快捷键</h2>
        <p>主题只保存在这台电脑上，不影响其他柜台。</p>
      </header>
      {theme === null ? null : (
        <div className="ld-settings-appearance__row">
          <span className="ld-settings-appearance__label">主题</span>
          <Tabs<ThemePreference>
            label="主题"
            mode="radio"
            items={THEME_PREFERENCES.map((preference) => ({
              id: preference,
              label: themePreferenceLabel(preference),
            }))}
            value={theme.preference}
            onChange={theme.setPreference}
          />
        </div>
      )}
      <dl className="ld-settings-shortcuts">
        {COUNTER_SHORTCUTS.flatMap((section) => section.rows).map((row) => (
          <Fragment key={row.action}>
            <dt>
              {row.keys.map((key, index) => (
                <Fragment key={key}>
                  {index > 0 ? "+" : null}
                  <Kbd>{key}</Kbd>
                </Fragment>
              ))}
            </dt>
            <dd>{row.action}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
