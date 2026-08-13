# ADR-57：BYOK 凭据托管生命周期与模型注册表

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 12
- 依赖：[ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)、[ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)、[ADR-37](2026-08-10-adr-37-cloud-web-primary-delivery.md)

## 背景

后续只读 AI 助手需要组织自带 provider 凭据和一份可审核的模型能力注册表。Item 12 只建立本地
凭据托管与治理边界；它不选择模型、不访问 provider、不引入 provider SDK，也不开放推理、tool
loop 或自动化。`store_features.ai` 继续默认且强制为关闭状态。

原始 API key 是 R5 密钥管理材料。它不能进入通用命令总线、WYSIWYS pending args、审计、日志、
错误、普通 API 响应或明文备份。数据库管理员拿到 PostgreSQL dump 也不应独立恢复明文凭据。

## 决策

### 1. Envelope 加密与 KMS 权威

每次新增或轮换凭据都生成独立的随机 256-bit DEK 和随机 96-bit GCM nonce，使用
AES-256-GCM 加密。AAD 固定绑定：

```text
org_id|provider_code|credential_id|envelope_schema_version
```

数据库只保存 ciphertext、16-byte auth tag、nonce、wrapped DEK、KMS key id/version、schema
version 和 last4。DEK 只在进程内短暂存在并在 wrap/unwrap 后清零。原始 HTTP 字符串无法由 JS
运行时保证原地清零，因此专用入口把它立即复制为 Buffer，业务完成或失败时清零该 Buffer，并禁止
任何序列化与日志记录。

生产 KMS 通过 `ByokKmsPort` 注入。代码库不提供环境变量明文 KEK、文件 KEK 或可导出的生产
master key；未注入 KMS 时新增/轮换失败关闭。测试 fake 仅供隔离回归，不是生产 adapter。

KEK 轮换只 unwrap/rewrap DEK，不能改变 provider ciphertext、nonce、auth tag 或 AAD 身份。

### 2. 生命周期

凭据使用不透明 UUID ref，按组织与 provider 单调递增 `credential_version`，并有独立
`row_version` 做 TOCTOU/CAS：

- `pending_verification`：Item 12 唯一可新建状态；尚未访问 provider，不得用于推理。
- `active`：预留给后续 provider adapter 在真实验证成功后原子激活；Item 12 HTTP 不提供激活。
- `invalid`：后续验证或运行失败可标记。
- `superseded`：轮换后被新版本替代；终态。
- `revoked`：R5 吊销；终态。

新凭据只替换旧的 pending，不会在尚未验证时停用当前 active。未来激活新版本时，旧 active 与新
pending 在同一事务内分别转为 superseded/active。每个组织/provider 最多一个 active 和一个
pending；应用角色无 DELETE/TRUNCATE 权限。provider 级 advisory lock、实体版本快照、RLS 和状态
trigger 共同拒绝并发覆盖与非法复活。单 provider 历史到 100 份后新增失败关闭，要求另行制定保留
策略，不允许本 Item 静默删除历史。

### 3. R5 专用 secret ingress

管理面只允许当前会话的 active admin 且必须具备 `ai_key_manage`：

1. metadata-only intent 接收 operation/provider/opaque ref/idempotency key，创建 R5 pending card；
2. 复用既有另一管理员 PIN challenge，签发 creator-session-bound、短时、单次 proof；
3. 专用 secret ingress 接收 `confirm_ref + step_up_proof_id + api_key`；
4. 在同一租户事务内按既有 staff authority 锁序重新验证并锁定 creator 会话/权限与另一管理员当前
   权限，再验证 pending hash、provider 实体版本，随后写入加密记录、消费 proof/pending 并写无秘密
   审计；任一步失败全部回滚；
5. 吊销使用相同 R5 流程，但终点不接收 secret。

所有 mutation 都要求 Origin/Fetch Metadata、double-submit CSRF 和独立会话限流。secret route 的
body 上限是 12 KiB，API key 只接受 8–8192 bytes 可见 ASCII 且不允许 CR/LF。通用
`/v1/commands` 不注册这些操作，避免 secret 或未验证管理意图进入 AI/tool 投影。

响应只返回 credential ref、provider、version、status、last4 和时间；不返回 ciphertext、wrapped
DEK、KMS 元数据或 secret。日志 redaction 同批覆盖 `api_key`/`secret`，异常只记录安全类型。

### 4. 模型注册表

`ai_model_registry` 是全局、应用只读、初始为空的 owner 维护表。每行必须带官方 HTTPS 来源、核验
时间、registry version、adapter family、token 上限和能力位。0064 不插入任何 provider/model，
也不推断“最新”型号。正式登记前必须用该 provider 官方文档单独核验；定价、可用区和动态能力不在
Item 12 猜测。

模型与凭据 list 都有硬上界；超界失败而不是静默截断。Item 12 不读取模型来发起网络请求。

### 5. PostgreSQL、RLS 与恢复约束

0064 创建全局 `ai_model_registry` 和 org-scoped `ai_provider_keys`。后者启用并 FORCE RLS，只以服务端
会话写入的 `app.org_id` 判定组织，绝不接受请求体租户。应用仅有 SELECT、INSERT 和受限列 UPDATE，
不能修改密文身份字段或物理删除。

数据库/照片恢复集只能恢复 encrypted envelope，不能恢复外部 KMS 权威。恢复或换机验收必须另外
证明所有非 revoked 凭据引用的 KMS key id/version 可用且 AAD unwrap 成功；否则 AI 凭据保持不可用，
由管理员重新走 R5 录入，不允许降级到明文 KEK、跳过 tag/AAD 或把测试 fake 用于生产。历史 KMS
版本在其最后一份非 revoked envelope 完成受控 rewrap 前不得销毁。

迁移编号固定为 0064。它依赖集成分支先具备 0054–0063；本隔离 Item 分支不得伪造占位迁移，也不得
单独运行连续 migration bundle 后宣称可发布。

## 否决的备选

- 环境变量/数据库中保存明文 KEK：数据库或进程环境泄露即可同时解密全部凭据。
- 直接用一个 KEK 加密所有 API key：无法逐凭据轮换与最小化密钥暴露。
- 把 secret 放进通用 command/pending：会扩大日志、审计、幂等缓存和 AI tool 暴露面。
- 新 key 写入后立即替换 active：未经过 provider 验证会破坏当前可用凭据。
- 在迁移中预置记忆中的模型名：型号、能力和 availability 会漂移，且缺官方核验证据。
- 数据库恢复时跳过 KMS 检查：会把“结构恢复成功”误报为“凭据可用”。

## 后果

- Item 12 提供可审计、组织隔离、失败关闭的本地凭据 custody；没有 production KMS adapter 时只能
  读取空模型/metadata，不能写 secret。
- 后续 provider adapter 必须单独决策网络 allowlist、超时/成本/熔断/SSRF/PII/injection、官方模型
  注册和真实 sandbox 证据；不得绕过本 ADR 读取数据库密文。
- `store_features.ai` 保持关闭；本 ADR、迁移和管理 API 不构成 AI 功能已上线或 provider 已接通的声明。
