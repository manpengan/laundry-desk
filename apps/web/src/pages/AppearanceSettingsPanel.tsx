/** 设置 → 外观与快捷键: device-local palette, light/dark and motion (ADR-99) + shortcuts. */

import { Icon, Kbd, Tabs } from "@laundry/ui";
import { Fragment, type KeyboardEvent } from "react";

import {
  MOTION_PREFERENCES,
  motionPreferenceLabel,
  paletteLabel,
  paletteNote,
  THEME_PALETTES,
  type MotionPreference,
  type ThemePalette,
} from "../appearance.js";
import { COUNTER_SHORTCUTS } from "../shell/ShortcutHelpDialog.js";
import { useThemeControl, type ThemeControl } from "../shell/shell-shortcuts.js";
import { THEME_PREFERENCES, themePreferenceLabel, type ThemePreference } from "../theme.js";
import { MotionSelfTest } from "./MotionSelfTest.js";

export function AppearanceSettingsPanel() {
  const theme = useThemeControl();
  return (
    <section className="ld-settings-section lg-card" aria-label="外观与快捷键">
      <header className="ld-settings-section__head">
        <h2>外观与快捷键</h2>
        <p>主题、明暗与动态效果只保存在这台电脑上，不影响其他柜台。</p>
      </header>
      {theme === null ? null : <AppearanceControls theme={theme} />}
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

function AppearanceControls({ theme }: Readonly<{ theme: ThemeControl }>) {
  return (
    <>
      <PaletteCards value={theme.palette} onChange={theme.setPalette} />
      <div className="ld-settings-appearance__row">
        <span className="ld-settings-appearance__label">明暗</span>
        <Tabs<ThemePreference>
          label="明暗"
          mode="radio"
          items={THEME_PREFERENCES.map((id) => ({ id, label: themePreferenceLabel(id) }))}
          value={theme.preference}
          onChange={theme.setPreference}
        />
      </div>
      <div className="ld-settings-appearance__row">
        <span className="ld-settings-appearance__label">动效</span>
        <Tabs<MotionPreference>
          label="动态效果"
          mode="radio"
          items={MOTION_PREFERENCES.map((id) => ({ id, label: motionPreferenceLabel(id) }))}
          value={theme.motion}
          onChange={theme.setMotion}
        />
        <p className="ld-settings-appearance__note">{motionNote(theme)}</p>
        <MotionSelfTest theme={theme} />
      </div>
    </>
  );
}

/** Pure: what the chosen motion tier means on this device. */
export function motionNote(theme: Pick<ThemeControl, "motion" | "resolvedMotion">): string {
  if (theme.resolvedMotion === "off" && theme.motion !== "off") {
    return "系统已开启“减少动态效果”，动画保持关闭。";
  }
  if (theme.motion === "auto") {
    return theme.resolvedMotion === "calm"
      ? "自动：这台电脑没有可用的显卡加速，已改用节能，背景保持静止。"
      : "自动：显卡加速可用，背景缓慢流动；没有显卡加速时自动改用节能。";
  }
  if (theme.motion === "calm")
    return "节能：背景静止，保留按压与切换反馈，适合远程桌面或较旧的电脑。";
  if (theme.motion === "off") return "关闭：不播放动画，界面变化立即完成。";
  return "标准：极光背景缓慢流动，按下有水波，导航与数字带回弹和滚动。";
}

const ARROW_STEP: Readonly<Record<string, 1 | -1>> = Object.freeze({
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
});

function PaletteCards({
  value,
  onChange,
}: Readonly<{ value: ThemePalette; onChange: (palette: ThemePalette) => void }>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const count = THEME_PALETTES.length;
    const next = THEME_PALETTES[(THEME_PALETTES.indexOf(value) + step + count) % count];
    if (next === undefined) return;
    onChange(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-palette="${next}"]`)?.focus();
  };
  return (
    <div className="ld-theme-cards" role="radiogroup" aria-label="主题配色" onKeyDown={onKeyDown}>
      {THEME_PALETTES.map((palette) => {
        const checked = palette === value;
        return (
          <button
            key={palette}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={paletteLabel(palette)}
            tabIndex={checked ? 0 : -1}
            className="ld-theme-card"
            data-palette={palette}
            onClick={() => onChange(palette)}
          >
            <span className="ld-theme-card__preview" aria-hidden="true">
              <span className="ld-theme-card__rail" />
              <span className="ld-theme-card__panel">
                <span className="ld-theme-card__chip" />
              </span>
            </span>
            <span className="ld-theme-card__name">{paletteLabel(palette)}</span>
            <span className="ld-theme-card__note">{paletteNote(palette)}</span>
            {checked ? (
              <span className="ld-theme-card__check" aria-hidden="true">
                <Icon name="check" size={14} strokeWidth={2.5} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
