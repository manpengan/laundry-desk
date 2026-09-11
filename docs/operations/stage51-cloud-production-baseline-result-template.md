# Stage 5.1 Cloud 生产基线结果模板

> 本文件是结果结构模板，不是验收证据，也不表示 production-candidate、离机、告警、容量或恢复已经
> 通过。填写时遵循
> [ADR-65](../adr/2026-08-25-adr-65-cloud-production-baseline.md) 与
> [阶段 5.1 计划](../superpowers/plans/2026-08-25-stage51-cloud-production-baseline-plan.md)。

## 1. 结果身份

| 字段                  | 值                                  |
| --------------------- | ----------------------------------- |
| 结果 ID               | `<required>`                        |
| 评估的 exact main SHA | `<40 lowercase hex>`                |
| required checks       | `<workspace-check / real-postgres>` |
| 环境 profile          | `<fixed allowlisted profile>`       |
| environment marker    | `<must equal profile marker>`       |
| 数据政策              | `synthetic-only`                    |
| 开始/结束时间         | `<canonical UTC timestamps>`        |
| 执行人与复核人        | `<non-secret owner references>`     |
| 最终结论              | `<PASS / BLOCKED / FAIL>`           |

## 2. 外部输入 register

- schema：`laundry.stage51.external-input-register` v1；
- canonical register：`<repository-relative evidence path>`；
- environment：`<blocked_external_environment / input_authorized>`；
- offsite：`<blocked_external_offsite / input_authorized>`；
- alerting：`<blocked_external_alerting / input_authorized>`；
- capacity：`<blocked_external_capacity / input_authorized>`；
- 派生 blockers：`<exact ordered list>`；
- `ready_for_profile_registration`：`<true / false>`。

register 只记录 `asset:`、`document:`、`owner:`、`ticket:` 类型的非秘密引用。主机私钥、密码、数据库
URL、receiver secret、顾客数据、请求体和原始凭据不得进入 Git、argv、日志或本结果。

解析通过仅证明记录结构与格式有效；引用目标、授权真实性与有效期须由执行人与复核人核实。

## 3. 对象与授权复核

| 类别        | 精确非秘密 identity 引用 | owner 引用   | 单独授权/批准引用 | 结论 |
| ----------- | ------------------------ | ------------ | ----------------- | ---- |
| environment | `<required>`             | `<required>` | `<required>`      |      |
| DNS/TLS     | `<required>`             | `<required>` | `<required>`      |      |
| offsite     | `<required>`             | `<required>` | `<required>`      |      |
| alerting    | `<required>`             | `<required>` | `<required>`      |      |
| capacity    | `<required>`             | `<required>` | `<required>`      |      |

全部外部输入达到 `input_authorized` 只允许进入“登记第二个固定 profile”的仓库切片。任何主机变更前仍须
再次列出本次动作的精确对象、命令边界和恢复路径，并取得对应授权。

## 4. 分层证据

| 证据层      | 必须记录的证据                                                       | 结论 |
| ----------- | -------------------------------------------------------------------- | ---- |
| software    | parser、权限、锁、失败路径、真实 PostgreSQL/照片集成                 |      |
| environment | 独立 authority/origin/data/secret/state 与 exact-main guarded deploy |      |
| offsite     | 独立 failure domain、完整副本摘要、从副本读取的 drill                |      |
| alerting    | receiver receipt、接收时间、clear 与失败重试                         |      |
| capacity    | 预冻结画像、2 倍负载 60 分钟、headroom、延迟与磁盘公式               |      |
| recovery    | 代码回滚、离机 joint recovery、RPO/RTO、失败重入                     |      |
| release     | exact green SHA、prepare/finalize、API/UI、marker/migration          |      |

不能用 hk-vps 改名、同盘目录、bind mount、journal、发送端 2xx、空闲资源截图、单独 `pg_restore` 或
`/health=200` 替代对应层证据。

## 5. 门禁与负向测试

- [ ] `workspace-check` 对 exact main SHA 成功；
- [ ] `real-postgres` 对同一 SHA 成功；
- [ ] profile/SSH/marker/路径漂移在网络动作前失败关闭；
- [ ] production-candidate 与 hk-vps 无共享可写状态、秘密或恢复集；
- [ ] offsite 损坏、断连、权限、容量与 lock 冲突保留旧有效 set；
- [ ] 告警 receiver 暂时不可用、重复失败与 clear 路径通过；
- [ ] 容量原始聚合证据可复算且不含业务请求或顾客字段；
- [ ] joint recovery 中断进入 `recovery_required` 并可精确重入。

## 6. 清理与保留

- 合成 fixture、临时数据库、临时凭据和 recovery target：`<cleaned / retained with reason>`；
- 远端 evidence、日志和指标保留位置：`<non-secret reference>`；
- release/data-protection 状态：`<stable / recovery_required>`；
- 已知限制与未关闭 blockers：`<exact list>`。

## 7. 阶段结论

仅当 ADR-65 §7 全部满足、所有外部 blocker 清空且每层证据独立通过时，结论才可为 `PASS`。否则必须
记录 `BLOCKED` 或 `FAIL`，不得以 `software_only` 冒充阶段 5.1 关闭，也不得导入真实顾客 PII。
