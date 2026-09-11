# Stage 5.1 外部输入差距结果（2026-08-28）

## 结论

**BLOCKED。** Stage 5.1-B1 命名环境基座已合入，但未取得 production-candidate、真实离机介质、
外部告警接收端或获批准容量画像的精确 identity/owner/authorization 引用。本结果不登记第二 profile，
不授权远端动作，也不关闭 5.1-A、5.1-B 或阶段 5.1。

## 评估基线

本表与 register 保留 2026-08-28 的历史评估身份，不代表当前主干的最新门禁结果。

| 项目                | 结果                                       |
| ------------------- | ------------------------------------------ |
| exact main SHA      | `29d02aaf8fbce32f2b4d9ccb02bb062128c583e9` |
| `workspace-check`   | `success`                                  |
| `real-postgres`     | `success`                                  |
| `runtime-app-macos` | `success`                                  |
| 数据政策            | `synthetic-only`                           |
| 远端变更            | 未执行                                     |

机器可读的 canonical register 见
[`2026-08-28-stage51-external-input-register.json`](2026-08-28-stage51-external-input-register.json)，
其 schema 由 `tools/cloud/stage51-external-input-contract.mjs` 严格验证。

## 外部差距

| 输入类别    | 当前状态                       | 缺少的非秘密引用                                       |
| ----------- | ------------------------------ | ------------------------------------------------------ |
| environment | `blocked_external_environment` | candidate、DNS/TLS、owner、单独授权                    |
| offsite     | `blocked_external_offsite`     | target、独立 failure domain、加密证据、owner、单独授权 |
| alerting    | `blocked_external_alerting`    | receiver、receipt/clear contract、owner、单独授权      |
| capacity    | `blocked_external_capacity`    | 冻结画像、API/UI 阈值、owner、产品批准                 |

四类引用必须使用 `asset:`、`document:`、`owner:` 或 `ticket:` 非秘密标识。密码、私钥、token、数据库
URL、receiver secret 和顾客数据不得进入 register 或阶段结果。

## 已建立的软件边界

- register 拒绝未知字段、错误 schema/version、非 canonical JSON、错误 main SHA/时间格式和错误 blocker；
- blocked 输入必须让所有引用保持 `null`，不能以半填字段冒充已取得输入；
- `input_authorized` 必须一次提供该类别全部必需引用；
- 部分授权只清除对应 blocker，其余 blocker 保持原顺序；
- 汇总结果只暴露 `ready_for_profile_registration`，不产生 `ready_for_host_mutation`；
- 可复用的阶段关闭记录结构见
  [`stage51-cloud-production-baseline-result-template.md`](stage51-cloud-production-baseline-result-template.md)。

解析器仅校验结构、引用格式和状态完整性，不解析引用目标，也不验证授权的真实性、有效期或
外部资产是否存在。`input_authorized` 是登记声明，必须由责任人复核对应引用；格式限制不能自动
识别所有秘密或顾客数据，提交前仍须确认引用内容不含这些信息。

本地复核方式：`node --test tools/cloud/stage51-external-input-contract.test.mjs`；该测试也由
`pnpm cloud:adr36:acceptance:test` 纳入现有 workspace 门禁。

## 下一门禁

1. 由 manpengan 提供或选择四类外部对象与责任人；
2. 将精确非秘密 identity 和单独授权写入新的 canonical register；
3. 在独立 PR 中登记第二个固定 profile，并证明未知 profile、任意 host/user/path 和跨环境误连失败关闭；
4. 任何 production-candidate 主机变更前，再次列出精确对象、动作和恢复路径并取得对应授权。

## 2026-09-10 本地整理验证

本批基于 `7444119384a3acf48adbbfa783cb1b29bcfed68a` 整理，保留上面的历史 register，未重新核验
外部资产，也未执行远端动作。补齐 malformed JSON 错误不保留原文/解析器 cause 的防泄露约束、
重复键拒绝和调用方 SHA 绑定回归；明确格式校验不替代授权复核。

- 定向 contract 测试：10/10，通过；
- `pnpm cloud:adr36:acceptance:test`：374/374，通过，无 skip；
- `pnpm workspace:format:check` 与本批 JS 的 ESLint：通过；
- `pnpm workspace:check`：在依赖审计处失败，错误为
  `DEPENDENCY_AUDIT_ADVISORY_UNEXPECTED:GHSA-c83g-rgw3-j3cx`，与主干 9 月 6 日
  [定时 CI](https://github.com/manpengan/laundry-desk/actions/runs/34059775474) 一致。
  其后串行门禁未执行，本批未修改依赖或审计例外，不声明全量门禁通过。
