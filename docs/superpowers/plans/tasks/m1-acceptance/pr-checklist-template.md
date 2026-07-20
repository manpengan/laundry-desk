# 每包 PR 验收 checklist 模板（V2-M1）

> 起草：Claude（设计与门禁）　日期：2026-07-20　T5 交付物
> 用法：**提交方复制到 PR 描述内逐项自查勾选**，未勾项写明理由；Claude 按同一份逐项验收。
> 不适用项标 `n/a` + 一句话理由，**不得留空**——留空视为未自查，直接退回。

## 0. 四条红线（M0 实测教训，任一违反直接退回）

- [ ] **证据强度 ≥ 结论强度**：PR 里每个"通过/绿/完成"都有可复现证据支撑；没跑的写"待实测"。
- [ ] **提交前已 rebase**：`git fetch origin && git rebase origin/main`，无覆盖他人已合入修复。
- [ ] **断言能失败**：新增测试已人为破坏验证过会红；无 `|| echo PASS` 一类恒真写法。
- [ ] **双锁文件同步**：本 PR 若增删依赖，`package-lock.json` 与 `pnpm-lock.yaml` 同时更新；已查 peer 兼容性。

## 1. 通用质量门禁

- [ ] TypeScript `strict` 零错（粘贴 `pnpm -w typecheck` 输出）
- [ ] ESLint + Prettier 零警告（粘贴输出）
- [ ] 单文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层
- [ ] 金额全程整数分，零浮点；渲染侧一律 `MoneyText`
- [ ] 无硬编码密钥/凭据；无真实客户 PII（手机号一律虚构 `13800000xxx` 段）
- [ ] 覆盖率：`packages/domain` **100%**，其余 ≥ 70%（粘贴报告摘要）
- [ ] 变更限于本包目录所有权范围内（跨目录改动须先说明并取得对应 AI 同意）

## 2. 架构约束（按包适用）

- [ ] **写操作只经命令总线**：无绕过总线直调 service（架构测试/依赖 lint 可证）
- [ ] 边界入参过 Zod；返回统一信封 `{ok,data}|{ok,error}`
- [ ] 租户上下文**只从服务端会话注入**，拒绝客户端/LLM/Edge 自报的 org/store
- [ ] 多表写入包事务；业务变更与审计写入**同一事务**（审计失败整体回滚）
- [ ] 契约变更走 contracts 包，未在实现侧另开第二套类型
- [ ] 错误处理：无 `catch` 吞异常、无裸 `any`、不静默失败

## 3. 安全门禁（命中即必填）

- [ ] 跨租户负向测试绿（五类旁路：GUC 未设置/空值/回滚残留/连接池串租户/worker 漏注入）
- [ ] AI 红队用例集绿（注入样本不产生未授权工具调用）
- [ ] 确认卡 WYSIWYS 断言绿（换参作废/过期不可执行/canonical 冻结/step-up 不可自核）
- [ ] R5 命令未进入 Tool Registry 投影（机制而非约定：类型排除或契约测试）

## 4. Electron 安全基线自查表（`apps/edge-agent` PR 必填，九项逐条）

依据 ADR-01 第 9 条 / 架构 §13.3；M0-4 已逐项验证过，M1 转正时逐条重勾。

- [ ] `nodeIntegration: false`
- [ ] `contextIsolation: true`
- [ ] `sandbox: true`
- [ ] `webSecurity: true`
- [ ] preload 最小化（仅暴露白名单 IPC）
- [ ] IPC 校验 sender
- [ ] `setWindowOpenHandler` 禁任意新窗口
- [ ] `will-navigate` 禁任意导航/外链
- [ ] 权限请求默认拒绝
- [ ] **Edge 内零业务校验逻辑**（校验语义全在 server 命令总线）
- [ ] 浏览器/IndexedDB 不持有交易或审计数据（只缓存 UI/字典）

## 5. 二审触发点（命中任一 → 必须 Codex 二审后才可合）

- [ ] 触碰 RLS 策略 / 审计权限 / Policy Engine / Primary lease
- [ ] Edge 密码学：配对、能力票据验签、执行回执签名、队列 DEK/KEK
- [ ] 鉴权中间件与 identity（argon2id / JWT / CSRF / RBAC）
- [ ] 命中项已请二审并附二审结论链接

> Codex 自己的 C6/C8/F1 因其本就是二审方，不另请他人二审，但**必须附实跑证据**。

## 6. 交付与文档

- [ ] PR 带种子数据或可复现步骤（评审者能独立跑起来）
- [ ] 双 CI 线（Build/Release + V2 Foundation）全绿
- [ ] `docs/CHANGELOG.md` 本期条目已补（面向用户的变化才写，内部重构不写）
- [ ] 涉及设计变更的，已追加 ADR（不回改已 Accepted 正文）
- [ ] commit 尾行 `Co-Authored-By` 署名自己
