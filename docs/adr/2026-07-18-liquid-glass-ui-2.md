---
title: ADR — 液态玻璃 UI 2.0（Liquid Glass）设计系统
date: 2026-07-18
status: accepted（manpengan 批准）
authors: claude (design), manpengan (decision)
supersedes: spec §3「UI 视觉规范」段落（spec 已同步 v1.1）
---

# ADR 2026-07-18 — 液态玻璃 UI 2.0 设计系统

## 1. 背景

M1 交付的 UI 是「毛玻璃 1.0」：静态 `backdrop-blur` + 白色半透明卡片。存在四个问题：

1. 色值 / 圆角 / 阴影以字面量散落在组件里（`#0071e3`、`rounded-[28px]` 等），无 token 层，不可维护；
2. spec §3 要求的**深色模式跟随系统**完全未落地；
3. 点击反馈只有 `active:scale-[0.98]`，无动态质感；
4. 玻璃用法无性能约束，柜台低配核显机型有掉帧风险。

manpengan 明确要求：视觉升级为 Apple 液态玻璃（Liquid Glass）动态效果，点击有动态美感，质感拉满。

**可交互设计基准（视觉真源）：** https://claude.ai/code/artifact/34c6aaf2-bb90-491e-a220-558b443fbe58
本 ADR 是工程真源；两者冲突时以本 ADR 为准。

## 2. 决策

立项 **UI 2.0**，作为独立里程碑 **M5（v0.5.0）**与 M4 并行开发，v1.0.0 = M4 + M5 完成。设计系统由「六条语汇」构成，全部 token 化，附带性能与可及性红线并纳入门禁。

### 2.1 六条设计语汇

| #   | 语汇         | 规则                                                                                     |
| --- | ------------ | ---------------------------------------------------------------------------------------- |
| 1   | **三层玻璃** | 模糊只发生在容器层；容器内的卡片用半透明染色（不再 blur）；边缘用 1px 内高光模拟折射     |
| 2   | **镜面追光** | 每块玻璃一枚 260px 径向高光跟随指针移动，悬停可见、离开淡出；只改 CSS 变量坐标与 opacity |
| 3   | **液态涟漪** | 按下 0.965 回压 → 释放弹性回弹；同时自触点扩散一圈水波纹                                 |
| 4   | **磁性焦点** | 导航 / 分段控件的活动态是同一枚玻璃 pill，被点击项「吸」过去，带轻微过冲，零布局抖动     |
| 5   | **呼吸背景** | 四团极光色斑以 26–40s 量级缓慢漂移，玻璃后面永远有内容可折射                             |
| 6   | **深浅同构** | 暗色不是反色：同一套 token 双主题重定义（玻璃换深烟色低透明、高光降档），组件零改动      |

### 2.2 设计 token（Tailwind 4 `@theme` CSS 变量，双主题全量）

命名前缀 `--lg-*`（liquid glass）。实现放 `src/renderer/src/assets/main.css`。

| token                            | Light                               | Dark                                | 用途                |
| -------------------------------- | ----------------------------------- | ----------------------------------- | ------------------- |
| `--lg-bg`                        | `#f2f3f7`                           | `#07070c`                           | 页面底色            |
| `--lg-ink`                       | `#1d1d1f`                           | `#f5f5f7`                           | 主文字              |
| `--lg-ink2`                      | `rgba(29,29,31,.62)`                | `rgba(245,245,247,.62)`             | 次级文字            |
| `--lg-ink3`                      | `rgba(29,29,31,.38)`                | `rgba(245,245,247,.38)`             | 弱化文字            |
| `--lg-accent`                    | `#0071e3`                           | `#0a84ff`                           | 品牌蓝              |
| `--lg-accent-soft`               | `rgba(0,113,227,.12)`               | `rgba(10,132,255,.18)`              | 品牌蓝底            |
| `--lg-accent-ink`                | `#ffffff`                           | `#ffffff`                           | 品牌蓝上文字        |
| `--lg-glass-hi`                  | `rgba(255,255,255,.82)`             | `rgba(44,48,62,.66)`                | 玻璃渐变亮部        |
| `--lg-glass`                     | `rgba(255,255,255,.55)`             | `rgba(24,26,34,.55)`                | 玻璃基色            |
| `--lg-glass-lo`                  | `rgba(255,255,255,.34)`             | `rgba(16,18,26,.42)`                | 玻璃渐变暗部        |
| `--lg-leaf`                      | `rgba(255,255,255,.52)`             | `rgba(255,255,255,.06)`             | 容器内卡片染色      |
| `--lg-leaf-hover`                | `rgba(255,255,255,.72)`             | `rgba(255,255,255,.11)`             | 卡片悬停            |
| `--lg-line`                      | `rgba(255,255,255,.9)`              | `rgba(255,255,255,.13)`             | 玻璃描边            |
| `--lg-line-soft`                 | `rgba(20,30,60,.08)`                | `rgba(255,255,255,.07)`             | 分隔线              |
| `--lg-inner-hi`                  | `rgba(255,255,255,.95)`             | `rgba(255,255,255,.16)`             | 1px 内高光          |
| `--lg-spec`                      | `rgba(255,255,255,.55)`             | `rgba(255,255,255,.17)`             | 镜面追光            |
| `--lg-shadow`                    | `0 30px 80px rgba(24,39,75,.14)`    | `0 30px 80px rgba(0,0,0,.5)`        | 大投影（窗口级）    |
| `--lg-shadow-sm`                 | `0 12px 32px rgba(24,39,75,.10)`    | `0 12px 32px rgba(0,0,0,.4)`        | 小投影（卡片/控件） |
| `--lg-ok-bg` / `--lg-ok-ink`     | `rgba(52,199,89,.16)` / `#1d7a35`   | `rgba(48,209,88,.18)` / `#4cd964`   | 语义：完成/待取     |
| `--lg-busy-bg` / `--lg-busy-ink` | `rgba(0,113,227,.12)` / `#0058c7`   | `rgba(10,132,255,.2)` / `#6cb2ff`   | 语义：进行中        |
| `--lg-late-bg` / `--lg-late-ink` | `rgba(255,59,48,.13)` / `#c22318`   | `rgba(255,69,58,.2)` / `#ff8078`    | 语义：逾期/危险     |
| `--lg-done-bg` / `--lg-done-ink` | `rgba(120,120,128,.14)` / `#6e6e73` | `rgba(120,120,128,.24)` / `#98989d` | 语义：已结束        |
| `--lg-blob-a…d`                  | 蓝/青/紫/橙 4 色斑（见基准页源码）  | 同名深色版                          | 极光背景            |
| `--lg-noise-op`                  | `0.028`                             | `0.05`                              | 噪点纹理透明度      |

**语义色独立于品牌蓝**：状态胶囊（在洗/待取/逾期/已取）只用语义四组，不得挪用 accent。

### 2.3 材质三档

| 档        | 用途                          | 配方                                                                                                                                                    |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`  | 应用外壳、Dialog/Sheet、Toast | `backdrop-filter: blur(26px) saturate(1.8)` + 渐变 `glass-hi → glass → glass-lo` + 1px `--lg-line` 描边 + `inset 0 1px 0 --lg-inner-hi` + `--lg-shadow` |
| `panel`   | 容器内的面板/统计卡/列表      | **不再 blur**，染色 `--lg-leaf(-hover)` + 描边 + 内高光 + `--lg-shadow-sm`                                                                              |
| `control` | 按钮、键帽、pill              | 同 panel 配方，圆角更小，按压态参与动效                                                                                                                 |

降级：`@supports not (backdrop-filter: blur(1px))` 时 window 档回退为 `--lg-glass-hi` 实底。

圆角阶梯：窗口 30px / 面板 22px / 卡片 20px / 控件 15–16px / 胶囊 999px。

### 2.4 动效规格（唯一标准，禁止各写各的曲线）

| 交互              | 时长 / 曲线                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| 按压回压          | `scale(0.965)`，80ms 进入                                                       |
| 释放回弹          | 500ms `cubic-bezier(.34,1.56,.64,1)`                                            |
| 液态涟漪          | 620ms `cubic-bezier(.2,.7,.3,1)`，直径 `max(w,h)×2.2`，自触点扩散               |
| 镜面追光          | radial 260px 跟随指针；opacity 0→`--lg-spec`，400ms ease                        |
| 磁性 pill（导航） | 450ms `cubic-bezier(.3,1.35,.45,1)`，transform-only（Framer Motion `layoutId`） |
| Segmented thumb   | 400ms `cubic-bezier(.3,1.3,.5,1)`（transform + width）                          |
| 页面转场          | 保留现状（进 260ms / 出 180ms + blur，`Layout.tsx` 已实现）                     |
| 数字滚动          | 850ms easeOutCubic，`font-variant-numeric: tabular-nums`                        |
| Toast             | 入场 500ms `cubic-bezier(.3,1.4,.5,1)`，2.6s 后自动退场 350ms                   |
| Dialog/Sheet      | 入场 500ms `cubic-bezier(.3,1.35,.5,1)`（y+scale），scrim `blur(10px)`          |
| 极光背景          | 4 色斑 `blur(90px)`，26–40s alternate 漂移，仅 transform                        |

### 2.5 组件清单（M5 交付）

改造：`GlassPanel`（三档材质）、`Button`（并入 Pressable 行为）、`Card` → panel 档、`Layout` 导航 → 磁性 pill、`StatCard`（数字滚动 + sparkline）。
新增：`Pressable`（涟漪 + 回压回弹，封装为通用交互基元）、`Dialog` / `Sheet`、`Toast`、`SegmentedControl`、`Switch`、`Skeleton`、`EmptyState`、`StatusPill`（语义四色）、`PickupKeypad`（取件码键盘，基准页有实物）。

### 2.6 深色模式

- 跟随系统：main 进程监听 `nativeTheme.on('updated')` → IPC 推送 renderer；
- 手动覆盖：`settings["ui.theme"] = "system" | "light" | "dark"`，落 `<html data-theme>`；
- CSS 结构：token 在 `:root` 定义 light 值，`@media (prefers-color-scheme: dark)` 与 `[data-theme="dark"]` 重定义，`[data-theme="light"]` 回写 light 值（手动覆盖必须双向可赢）。

### 2.7 性能与可及性红线（纳入门禁清单）

1. 同屏 `backdrop-filter` ≤ 8 层；列表滚动区内**禁止逐行玻璃**（行只用染色）；
2. 动画只允许 `transform` / `opacity` / `filter`；禁止动画 `top/left/width/height/box-shadow`；
3. Windows 10 核显实机 60fps：页面切换、涟漪连点、列表滚动无可见掉帧（manpengan 走查，不达标不通过）；
4. 动效降级：系统 `prefers-reduced-motion` 或 `settings["ui.reduce_motion"]` 开启时，关闭涟漪 / 极光漂移 / 数字滚动，保留即时状态变化；
5. 双主题全路由走查；键盘焦点态可见（`focus-visible` 环）；文字对比度不低于 WCAG AA。

### 2.8 实施约束

- **token 唯一来源**：组件禁止出现色值 / 阴影 / 圆角字面量；CI 增加检查（grep `#0071e3|rgba(0,113,227` 等出现在 `components/|routes/` 即失败）；
- **零新增运行时依赖**：涟漪 / 追光 / 数字滚动手写（各 ≤ 50 行），磁性 pill 用已有 framer-motion；
- 单文件 ≤ 400 行等既有红线不变。

## 3. 后果

- ✅ 视觉差异化 + 可维护（改主题 = 改 token）+ 性能有护栏 + 深色模式补齐 spec 欠账；
- ⚠️ renderer 全路由换装，工作量约 4 个 PR（见 M5 issues），与 M4（main 进程为主）正交可并行；
- ⚠️ 低配机风险由「动效降级开关」兜底；
- spec 已同步 v1.1（§3 指向本 ADR，§7 路线表、§8 门禁更新）。

## 4. 实施拆分

对应 GitHub M5 milestone 下 4 个 issue：token 层 + 深色模式 → 交互基元（Pressable / GlassPanel）→ 磁性焦点 + 组件补齐 → 全路由换装 + 性能验收。
