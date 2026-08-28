# 进度日志

> **本文件已纳入版本控制，且仓库是公开的。** 写入前自查：不得出现密钥、口令、PIN、release
> token、真实顾客 PII，也不得记录主机上凭据文件的具体路径或变量名（这类定位信息发到公开
> 仓库等于给出半张地图）。运维私有细节留在主机侧记录，本文只写判据、结论与可复核的标识。


## 2026-08-27：Claude 只读核对与 #203/#204 收口

> 本节由 Claude 追加，不改动 Codex 的 8-23 记录。会话从 8-15 跨到 8-27，期间路线由 Codex 推进。

- **线上现状（只读核对）**：live marker `c8919af3c666cf70df2fbf04645ebdf0f377f35a`，其 history
  记录为 `outcome=committed`、`verification_evidence_authoritative=true`、
  `compatibility_decision=same_migration`、head `0069_bounded_automation.sql`，
  创建于 `2026-08-25T08:32:40.437Z`（台北 16:32）。无活动 transition，`phase=stable`；
  `laundry-desk`/`postgresql`/`caddy`/`kb-web` 四服务均 active。
- **留存已恢复健康**：history 7、controller 7、backup 7 对、`/opt` 常驻 5。按峰值口径
  `5 + incoming + next = 7 < 8`，四类集合都有余量，Stage 5.0 的解阻目标达成。
- **主干**：`main = origin/main = c8919af`，工作树 clean。open PR 只剩 #209
  （关闭 Stage 5.0、启动 5.1，含 ADR-65 与 `2026-08-25-stage50-release-result.md`），尚未合入。
- **Claude 于 8-15 开的两个 PR 今日已关闭**，理由是被取代而非被合并：
  - #203（公网 health/SPA 探针有界重试）与 #204（退役已被取代的 committed 回滚树）的实现，
    均已由 `198b0d0`（Stage 5.0 归档安全门禁，8-20 经 #206 合入）重新实现并进入 `main`；
  - 两个分支的提交 `986c1fd` / `87e1584` **都不是 `main` 的祖先**；
  - 逐文件核对确认 `main` 完整覆盖且更完善，无内容丢失；远端分支按 Git 授权约定保留未删。
- **写入位置更正**：`progress.md` 与 `findings.md` 的新条目应写在**文件顶部**。Claude 8-15
  那次误追加到文件末尾，该条目仍留在原处，不迁移以免打乱既有引用。

## 2026-08-23：Stage 5.0 → 5.1 顺序交付启动

- 发布前再次确认 clean `main=origin/main=b9ddacc…`、ahead/behind `0/0`、三项精确 SHA checks
  全绿、migration head `0069`，四服务 active、failed units=0，Desk/KB loopback 与公网健康通过。
  单进程内存 token 包装执行 prepare→finalize，输出脱敏；最终
  `CLOUD_RELEASE_COMMITTED candidate_sha=b9ddacc9ae85551ce6b66f7da9f1dd7811d3e6ca`，status 回到 stable。
- committed history/evidence 白名单复核：expected=`c04f858…`、same migration、old code compatible、
  pre-migration 69/0069、write gate released、terminated sessions=0、app role restored、authoritative=true；
  verification id `1cd71cc6-23f4-46ab-b3b1-cdcd971a860c`，API run
  `ADR36-20260823T124446193Z-33ec35fe` 20/20 PASS，Browser run
  `CLOUD-BROWSER-20260823T124605298Z-a98a21a8` PASS、1 test、retries=0。
- 独立 post-deploy 复核：marker/live=`b9ddacc…`；数据库 69/head 0069；`laundry_app` LOGIN、
  NOSUPERUSER、NOBYPASSRLS；四服务 active、failed units=0；Desk/KB 内外健康均通过；Desk 8787、
  PostgreSQL 5432 和 KB 8700 仅 loopback，Caddy 80/443 对外。
- 成功发布又消耗一格，live inventory 回到 `/opt=6`、history/controller/backup=`8/8/8`、evidence=7，
  三类 room false；live preflight 以 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT` 正确失败关闭。
  fresh superseded list 为 5 项，最早剩余候选是 `7989206b-before-6f106076`；release-set list 只有
  `7989206b…` / digest `5c851e87…a8` / `committed`。按 ADR-64 §5 还需新一轮两次独立精确授权。
- 第二次授权执行前再次复现固定主机指纹、root key-only 主机健康、`phase=stable` 与精确
  `53b012c…` / digest `20d3715a…98` / `rolled_back` 身份；runner 成功返回
  `CLOUD_RELEASE_SET_OK state=archived ... items=4`，没有触碰 `7989206b…/committed`。
- 写后 inventory 与 preflight 均成功：stable/live `c04f858…`，`/opt=5`、峰值 7，
  history/controller/backup=`7/7/7`，evidence=6，可用约 15.74 GB，三类 room 全 true；
  普通 artifact list 为 0，release-set list 只剩 `7989206b…/committed`。Stage 5.0 retention
  阻塞已解除，进入精确 `b9ddacc…` 发布前复核。
- 用户已对精确 release-set 三元身份 `53b012c62ae0956ca58ef4cc1b8f46091c97d5b9` /
  `20d3715ada9b5aaebf30f03297d628520fea60570cf5d6a9f641f059fbc18198` / `rolled_back`
  授权执行 manifest-bound archive；执行前仍 fresh list 复现，授权不延伸到 `7989206b…/committed`。
- 已在 fresh 指纹、主机健康、`phase=stable`、inventory 与五项候选列表均复现后，使用 exact-main
  维护树退役获授权对象；runner 返回 `CLOUD_RELEASE_ARTIFACT_ARCHIVE_OK`，共 55,880 项、
  909,189,258 bytes、inode `1096495`，目标为 root-private
  `/var/lib/laundry-desk-release-archive/rollback-ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6-before-7989206b3e9748b2a607687466ef2e0775ad528e`。
- 写后 inventory 为 stable/live `c04f858…`，`/opt 6→5`、峰值 `8→7`、
  `artifact_room false→true`；history/controller/backup 仍 `8/8/8`、room 仍 false。普通 artifact
  列表仍 0，superseded 列表 `5→4` 且精确对象消失；主机 failed units=0，未删除、未改数据库或服务。
- 退役后 release-set fresh list 为 2 项：旧失败回滚 `53b012c…` / digest `20d3715a…98` /
  `rolled_back`，以及已提交 `7989206b…` / digest `5c851e87…a8` / `committed`。推荐保留后者，
  对前者请求第二次独立精确归档授权；尚未执行 release-set archive 或 preflight。
- 用户已对精确对象
  `laundry-desk.rollback-ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6-before-7989206b3e9748b2a607687466ef2e0775ad528e`
  授权执行 `--retire-superseded-rollback`；本轮将在 fresh list 复现该完整名称后只执行这一项
  same-filesystem 可恢复 rename，随后重新盘点并停在 release-set 的独立授权门禁。
- 用户明确要求按上一轮推荐顺序实现，完成后提交、推送并部署。
- 已完整读取 `planning-with-files-zh`、`hk-vps-ops`、`git-commit` 技能及三份历史计划文件；
  本轮远端操作固定使用 pinned key-only `hk-vps` authority，提交使用仓库日志规范。
- GitHub 基线已刷新：本地干净 `main = origin/main = b9ddacc9ae85551ce6b66f7da9f1dd7811d3e6ca`，
  精确 SHA 三项 checks 全绿；开放 PR #203/#204 均为落后、冲突且功能已被当前 main 覆盖的旧候选。
- 当前先执行 Stage 5.0 新鲜只读远端盘点；在获得精确对象身份前不执行任何归档或部署。
- hk-vps 固定 ED25519 指纹匹配；`ssh -G` 精确为 root@103.233.252.201:22、专用
  `~/.ssh/hk_vps_ed25519`、`IdentitiesOnly yes`、严格主机密钥校验。显式 BatchMode key-only 登录
  成功；密码与键盘交互认证均关闭。主机 failed unit=0、reboot_required=no。
- release status 新鲜返回 `phase=stable`。exact-main 维护树 inventory 返回 live `c04f858…`、
  `/opt=6`/峰值 8、history/controller/backup=`8/8/8`、evidence=6、可用 15,753,420,800 bytes，
  `artifact_room=false history_room=false backup_room=false`。
- 普通 artifact list 为 0；superseded rollback list 为 5；release-set list 唯一候选为
  `53b012c62ae0956ca58ef4cc1b8f46091c97d5b9` / token digest
  `20d3715ada9b5aaebf30f03297d628520fea60570cf5d6a9f641f059fbc18198` / `rolled_back`。
- 最远离当前 live 的 superseded rollback 是
  `laundry-desk.rollback-ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6-before-7989206b3e9748b2a607687466ef2e0775ad528e`；
  runner 已在列表阶段验证其完整资格。按 ADR-64 先请求该精确对象的退役授权，尚未执行 rename。
- 本轮尚未修改业务代码、提交、推送、归档、preflight 或部署。

## 2026-08-13：阶段 3.2–4.5 云端发布与仓库证据回写

- PR #171–#181 依次合入 `main`；最终候选为 `65bd8210c824037d4c871a46ce3eaf3e3dc1c314`，
  精确 merge SHA 的 V2 Foundation `#31705863621` 与 V2 PostgreSQL Integration `#31705863502` 双绿。
- 首个候选 `53b012c` 两次尝试均回滚：第一次 `10:08:45Z → 10:08:47Z` 终止于 `staged`，未进入迁移；
  第二次 `10:15:24Z → 10:38:00Z` 已过写门闩与迁移（`pre_migration_count=48`、`write_gate=released`）
  后终止于 `recovery_required`。两次 `verification_evidence_authoritative=false`，符合失败关闭设计。
  PR #179/#180/#181 修复会员折扣发布验收、订单财务会员定价隔离与顾客档案验收清理后重新发布。
- 成功发布：transition `14:02:53.718Z` 创建，写门闩 `14:02:57.305Z` 证明且终止会话 0 个；marker 于
  台北时间 `22:13:47` 落盘，迁移账本 `22:14:05` 推进到 0069，服务 `22:14:06` 进入 active；
  evidence `14:15:23.403Z`，committed `14:15:29.036Z`，`verification_evidence_authoritative=true`。
- 公网验收：API `ADR36-20260813T141444815Z-14770fe2` 19/19 journey + overall 全 PASS（schema v6），
  较阶段 3.1 的 15 条新增 `owner_store_operations`、`member_benefits`、`customer_profile_policy`、
  `notification_delivery_boundary`、`factory_handoff_boundary`，且 `reminder_history` 由 BLOCKED 转 PASS；
  Browser `CLOUD-BROWSER-20260813T141515380Z-b80bae46` PASS、`retries=0`。
- 发布后独立只读复核（22:24）：transition `stable`；live marker 精确等于 `main`；部署树与数据库均为
  69 条、head `0069_bounded_automation.sql`；四个 systemd unit active、failed units 0；loopback/公网
  health 正常；retention 为 history 7 / controller 7 / backup 12 / evidence 4，`/opt` 产物 7 个。
- 风险留痕：`old_code_compatible=false`、`compatibility_decision=unproven`，代码回滚不再被证明兼容当前
  schema；`/opt` 产物数接近阶段 3.1 触发过的保留上限，下次发布前需先按明确授权归档失败产物。
- 仓库证据回写（本次由 Claude 执行，事后复核重建，非发布操作者同步记录）：新增
  `docs/operations/2026-08-13-stage32-45-release-result.md`，并同步 README 当前阶段/代码面/发布索引、
  `docs/CHANGELOG.md` 发布声明与 Cloud Web-first 交付计划的阶段 3/4 状态。foundation 治理门禁 31/31、
  `workspace:format:check` 全绿。

## 2026-08-13：Items 4/7/9/10 并行收口

- 用户要求停止同一功能一轮又一轮的细粒度复审，改为快速实现优先：每项保留一轮聚焦测试、
  lint/type/build 与必要安全自查；已发现 blocker 必须修，但不再为同一修复重复启动独立 reviewer。
  Item 5 stable diff 已有 focused 20/20、Web 448/448、lint/type/build、SPA/diff/size 全绿，直接形成
  单提交；Item 7 四项 blocker 修后有 Contracts 797、DB 86、Server 924+91 skip、Web 409 与 focused
  门禁，直接 amend；Item 10 只关闭最后发现的 Caddy named-route 控制流绕过并跑一次 focused。
- Item 7 已按该节奏收口为唯一提交 `1111f73cfcfc8f1b69242d9dd019d390bba3da5e`
  （parent=`d37692c`，clean，未 push）。四项安全修复、Contracts 797、DB 86、Server 924+91 skip、
  Web 409、focused、diff/size证据均写入提交；新增真 PG ACL/并发用例留统一集成链执行。
- Item 5 已形成唯一提交 `3791cb778c11177801ade12de15fefeac6c7bfcb`（parent=`58bb10e`，
  clean，未 push）：精确 `/mobile/tasks`、移动任务/订单状态推进、完整 WYSIWYS、scope generation +
  AbortSignal、离线只读与 mobile-only cookie resume。focused 20/20、Web 448/448、lint/type/build、
  SPA entries=3、diff/size均绿；按用户最新节奏不再追加独立复审。Item 6 已从该 exact SHA 启动。
- Item 5 已无冲突串入统一集成 v2 为等价提交 `e054c7e`；集成 Web typecheck、diff-check 与 clean
  worktree 通过。迁移头仍为 0057，Item 6 完成 0058 后才串 Item 7 的 0059。
- Item 10 最终单点修复已 amend 为唯一提交 `ce253c2990711a46c1253829d379ae1891e13862`
  （parent=`af54ff1`，clean，未 push）：Caddy contract 按顺序解析 `server.named_routes`/`invoke`，
  每个可达 8787 proxy 必须自身满足 Host/source/delete，missing/cycle/unknown/上界均 fail closed，
  unsafe-first 不能由 safe-later 洗白；focused 9/9、node-check、ESLint、diff通过。按新节奏不再追加
  审查轮次，Item 11 已从该 exact SHA 启动。
- Item 12 已从 `f8099f2` amend 为唯一提交 `0a0ee503ee8a6af914ba3c0c78212f372f967a7e`
  （parent=`d37692c`，clean，未 push）：`ai_provider_keys` 对 app role 的表 INSERT/UPDATE 全封，
  外层普通 SELECT 读取 expected version，固定 search_path 的 definer 内部锁行/CAS并证明active admin、
  tenant、R5 authority 与 DB time；owner-only rewrap保持密文/nonce/tag。real PG 1/1、Contracts 3、
  DB 6、Server 12及type/build/lint/diff/size/secret均绿，临时PG已清。
- Item 14 已从 exact Item 12 启动，跳过仍受外部测试凭据约束的 Item 13 实际连接层；本切片只实现
  provider-neutral SSE、deterministic fake adapter、默认 hard-off 与有界 read-only synthetic tool loop，
  不读取密钥、不调用外网、不选择真实 provider，后续可在 Item 13 adapter就绪后接入同一port。

- Item 7 最终独立安全审查没有放行当前 shared diff：R4 PIN 在途取消后仍能提交旧确认、0059
  过早授予 app-role 预算账本 INSERT、marketing HTTP 面缺专用限流，以及 set/freeze 首跳同一
  idempotency key 会生成多张有效确认卡。四项已冻结为同一 Item 7 修复范围，APPROVE 前不 amend、
  不集成；既有 WYSIWYS、actor/version/DB time、深层 DSL、RLS 与 PII 边界保持不回退。
- Item 10 exact `8c5bc48` 的再复审识别出 Caddy preflight 可被 decoy handler 绕过、logout 可能先
  被限流而不吊销、customer merge 可由 app-role direct UPDATE、duplicate tab 共用 authority，及
  logout OpenAPI/严格响应缺口；五项已闭环并 amend 为 exact `2dc1b2c395f231579ac3de3e24304a51f1b42575`
  （parent=`af54ff1`，单提交、clean、未 push）。Caddy 4/4、Server 22/22、Web 16/16、Contracts/
  OpenAPI 12/12、DB static 3/3，以及 fresh 0001→0061、真实 PG 1/1 均绿；direct merge DML 精确
  42501，merge/login 锁序由 advisory wait 且 tuple lock=0 证明，所有临时资源已清。等待原独立
  reviewer 对 exact SHA 复核。

- Item 4 已完成 0057、任务状态机、Server/Web 与真实 PostgreSQL 主体门禁：fresh 57 migrations、
  Item 3/4 PG 各 1/1、catalog 1308，workspace format/lint/typecheck/build 与 Web 427/427、Server
  952 pass + 93 opt-in skip 均绿。独立终审发现人工接管 step-up 在取消后可能接纳迟到 PIN 成功；
  已用 scope+confirmRef+generation authority 关闭两个异步返回点与最终 resume，并以 13/13 deferred
  focused 回归验证。原审查者最终 APPROVE，已形成严格单提交
  `58bb10eb3f8fc9a4630ed50a0053c0eb87ffc545`（parent=`ca340bd0...`，rev-count=1，clean，未 push）；
  最终 Web 428/428、Edge SPA 3/3、lint/format/diff/size/secret 门禁均绿。Item 5 已从该 exact SHA
  在独立 worktree 启动。统一集成 v2 已语义解决 pending preparer/envelope/foundation 四处预期
  冲突并串入等价提交 `00b62f1`；Contracts/Domain/Server/Web typecheck 与 foundation 通过，且补入
  显式 desktop operation registry 类型以关闭新增命令导致的 TS7056，不改变运行时命令面。
  集成 fresh 0001→0057 首轮所有 ADR46/47/48/49 app-role 行为均通过，仅识别出 0057 原 golden
  仍基于修复前 0054；重新从隔离数据库实算并冻结为 `1322/6805b93c...15e7` 后，第二轮 catalog、
  write gate、Cloud data protection、二次 commissioning 全绿，容器/网络/卷与 8543 均清理。
- Item 9 第二轮只读复审确认原三项 blocker 已关闭，但发现团购 redemption 已存在时会在比较冻结
  authority 前直接 replay success。PG/内存现均先比较完整冻结 authority，并覆盖“旧卡冻结→新
  authority 抢先兑换→旧卡恢复拒绝”；原审查者最终 APPROVE，已形成唯一提交
  `cc30ca029aa6e33b3b2d53c239ff7123bbf85809`，parent=`d0ec3015...`，worktree clean，未 push。
- Item 10 的最终五项已闭环并 amend 为严格单提交
  `8c5bc483bc97cc0aeddd19c7e70d720ba400066c`：tab-scoped cookie authority 使用 SHA-256
  selector，Caddy 可信客户端 IP 入口、15 分钟到期清屏/abort、三条 auth OpenAPI 与 canonical
  customer group merge 事务内 session cap 均有回归；fresh 0001→0061 与真实 PG 1/1 通过，等待
  再次独立安全复审。
- Item 7 的 pending/WYSIWYS、DB actor/version/time guard、Web generation 与真库负例已通过 focused
  type/build/lint/test/format。完整 isolated `local:commissioning:fresh:pg` 已成功迁移/投产到 0059，
  随后 legacy runtime bundle 因该隔离分支有意保留 0054–0058 编号给 Items 1–6 而以
  `RUNTIME_MIGRATION_BUNDLE_INVALID` 停止；精确 Compose 容器、网络、卷与 8543 已清理。该失败
  不是 0059 SQL 行为反例，完整 0001→0059 证据必须等 0057/0058 实现进入统一链后再跑。

## 2026-08-13：Items 1–3 新集成链与 Item 9 终审

- 新建 `codex/stage44-45-integration-v2` 并从当前 `main@27f0a7a` 依次串入 Items 1–3；Item 3
  等价提交现为 `c4bb908`，三项仍保持各自单一提交。
- 最终 Item 1 的 0054 数据库 guard 改变了后继 catalog，fresh 隔离链重新计算并冻结：0055 为
  `1280/ad7ae4ab…3bed`，0056 为 `1299/f466ee36…fcf7`。完整 0001→0056 PG、ADR46/47/48、
  catalog/write-gate、数据保护与二次 commissioning 均通过，精确容器、网络、卷和临时配置已清理。
- fresh PG runner 改为构建 `@laundry/server...` 依赖图，避免读取陈旧 Contracts/Domain dist；
  foundation 37/37 与格式/diff 门禁通过。
- Item 9 独立安全审查 BLOCK：确认卡遗漏完整非秘密 authority、活动/会话/输入变化可接纳旧异步
  响应、完全相同推荐重放在预算耗尽后失败。已退回原实现分支补 WYSIWYS、generation authority
  与 replay-before-drift 回归，修复并复审前不提交。

## 2026-08-13：改为 18 项完成后统一部署

- 用户明确取消“做一个就部署一个”的节奏：先完成、逐项提交并统一集成 18 项，最后只做一次
  hk-vps 发布。此前 0053 单独发布到验收阶段后因真实 acceptance 缺口回滚；受控恢复最终成功，
  线上重新为 `stable / f276bdb…fdca / 0048`，Desk/PostgreSQL/Caddy/KB 与公网 health 全绿。
- 失败的 `458f08b2`、`4d331577` 数据库均以 `ALLOW_CONNECTIONS=false` 隔离保留；4d331 的
  history/controller/backup/failed tree 仍完整保留在活动 retention 集合。适配归档脚本已准备但
  按新顺序不执行，最终统一发布前再复审并归档释放槽位。
- 当前实现提交为 4/18：Item 1 `68cb640`、Item 2 `f9011ab`、Item 7 `8eb3c7b`、
  Item 12 `f8099f2`。Item 2 已独立终审通过；集成分支 `codex/stage44-45-integration` 基于
  `main@27f0a7a` 保留 Item 1/2 两个独立提交，Turbo 权威 typecheck 7/7。
- 并行在制：Item 3 权威配送订单与真实 PG/员工 Web，Item 8 关闭券快照/预算锁后重算/UI epoch
  三个终审 blocker，Item 10 顾客自助查询与专用短会话。Item 13 因 OpenAI API key 技能的硬
  credential decision gate 暂停，未读取、创建或输出任何真实 provider 密钥。

## 2026-08-13：Items 3/8 独立终审进展

- Item 8 已 amend 为 exact `d0ec3015e2759965f66d95684acc5d9adff1d1c5` 并通过第二轮独立终审：
  P0/P1/P2 均为 0；锁后预算快照、券完整 authority 与两条 UI generation 竞态均已闭合，真实
  PostgreSQL 双连接证明第二跳等待 campaign lock 后读取 fresh ledger。当前已形成提交数为 7/18，
  Item 9 已从该获批 SHA 独立启动。
- Item 3 exact `619db18` 的数据库 trigger、FORCE RLS、CAS、状态机与事务审计暂未发现 P0/P1；
  独立终审阻断员工 Web 的 stale-response/WYSIWYS P1。候选已退回原分支，正在为 session/list/detail/
  transition 增加 generation + 完整 authority key，并补 A→B、切会话与首跳后改目标的 deferred 回归；
  修复并复审 APPROVE 前不集成、不启动 Item 4。

## 2026-08-13：Item 10 顾客自助形成单提交

- Item 10 已形成严格单提交 `df6c19f`（父 `af54ff1`）：独立 15 分钟哈希会话、CSRF、反枚举和
  限流，五条顾客自助查询，canonical customer group 的订单/票据/衣件进度只读投影，以及
  `/customer` 响应式 Web。当前实现提交数更新为 5/18。
- fresh PostgreSQL 0001→0061 为 56/56，真实门户行为 1/1；Contracts 806、DB 90、Server
  938 pass + 92 opt-in skip、Web 413 与 production build 均绿，临时容器/网络/卷/密钥已清零。
- 已启动独立 security review，重点复核会话/CSRF、跨主体与跨租户隔离、PII 最小化、函数 ACL、
  合法余额支付票据投影和通用 staff query 路由不能旁路顾客 authority；APPROVE 前不集成。

## 2026-08-13：Item 3 权威配送订单形成单提交

- Item 3 已形成严格单提交 `619db18`（父 `f9011ab`）：ADR-48/0056、三条受支持路线的完整不可逆
  状态机、canonical 顾客与预约/洗衣订单绑定、双后端 Server、R3/CAS/审计事件、员工 Web 工作台。
- fresh PostgreSQL 0001→0056 为 56 migrations，`ADR48_DELIVERY_ORDERS_PG_ACCEPTANCE_OK`，
  catalog 1285 / `0bb4f14f…dac5` 与 write gate、Cloud 数据保护/commissioning 均绿；Domain 188、
  Contracts 807、DB 94、Web focused 24，workspace typecheck 12/12、build/lint 9/9。
- 端口、容器、网络、卷与临时配置均清零；已启动 exact `619db18` 独立安全/数据库复审，通过前
  不集成也不启动依赖它的 Item 4。

## 2026-08-13：Item 10 独立安全终审要求修复

- exact `df6c19f` 被独立复审阻断：顾客票据漏接生产合法 `balance` 支付会整单 500；Web 异步
  请求缺 session epoch，登出/换用户后可能复活上一顾客 PII；Caddy→loopback 时 `request.ip`
  会把公网顾客聚为一个 IP 桶而形成全局登录 DoS。
- Item 10 已回原隔离线 amend：对齐五种支付方法、加入跨会话 deferred-response 回归，并在继续
  拒绝不可信 Forwarded 的前提下重做反代来源限流 authority；修后重新跑真库/全门禁与独立复审。

## 2026-08-12：用户要求多 Agent 继续完整交付

- 用户确认继续并明确要求使用多 Agent 完成；现有 18 项实现计数为 `0/18`，因为固定前置
  0053 发布尚未成功，任何审计、设计或发布控制器修复都不计入 18 项完成数。
- 并行工作限制为互不冲突的发布根因实现、独立安全复核与 Stage 4.4/4.5 架构/文件映射；
  领域生产提交仍按 1→18 串行形成，避免数据库迁移、freeze 清单与共享总线发生冲突。

## 2026-08-12：0053 bootstrap 匿名失败修复进入终审

- 只读取证把第二次真实失败收敛到 transition/controller 之前的 bootstrap shell；原脚本的 archive、
  staging、extract 和 remote entry 裸失败会折叠成 `CLOUD_RELEASE_REMOTE_DEPLOY_FAILED`。
- 安全复核同时发现旧 EXIT cleanup 在 staging collision 时会递归删除不是本轮创建的目录；修复现以
  `staging_created` + dev/inode 身份绑定限制删除，并让文件、目录、symlink collision 内容保持不变。
- 新错误协议只允许固定 allowlist 单行：archive invalid/digest mismatch、staging collision/create、
  extract、remote entry、cleanup 与 lock；Node 的既有单行安全码（尤其 recovery required）可保留，
  多行、无 LF、stdout 噪声、超长或带 token 的输出折叠为固定码。
- 新独立 bootstrap shell 回归与 core focused 为 20/20；全量 cloud 为 281 pass + 1 Linux-only skip；
  `pnpm workspace:check` 完整 exit 0，格式/lint/typecheck/tests/build 均绿，生产/测试文件未越线。
- 18 项仍为 `0/18`；Item 1 只读设计已冻结为 ADR-46/0054 的政策配置与 policy-only quote，且为保证
  0053 回滚兼容不会提前把 `store_features.delivery` 改为 true，也不夹带预约/订单/地图/provider。


## 2026-08-12：0053 首轮发布被 controller 嵌套目录阻塞

- 用户授权先发布 `f2d40ce…4eee / 0053`，再按 1→18 每项独立 commit 实现 Stage 4.4/4.5，
  最后运行总门禁、推送并部署精确主线 SHA。
- 经明确授权，最旧 `629bc9c…f1a1` rolled-back history/controller 已原子移入 root-only
  可恢复归档，活动集合 `8/8 → 7/7`，manifest SHA-256 为 `3d375a9a…bffaa`。
- `a832bbd…be01` failed tree 已在 release lock 下逐项摘要、原子移入可恢复归档并移动后复算；
  56,157 项、880,072,698 字节，tree manifest `7266841e…47e3c`，活动制品 `6 → 5`，
  全量 release preflight 通过。
- 首次 keyscan 失败经只读复核判定为零写入瞬时失败；归档后的真实 `prepare` 随后返回
  `CLOUD_RELEASE_REMOTE_DEPLOY_FAILED`，远端自动恢复 `stable`，marker 仍为 `f276bdb…fdca`，
  migration 仍为 `0048`，四项服务 active、failed units 0、公网 health ready。
- 首因已从代码路径确定：`f2d40ce` 新增 `tools/cloud/systemd/`，而
  `copyCloudFiles()` 对 `tools/cloud` 一级条目一律调用普通文件读取；controller 在 transition
  持久化前以 `CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID` 失败。独立修复分支已补递归、私有权限、
  摘要 inventory、嵌套目录与前缀排序回归；独立 TS/安全复审发现并关闭 manifest/validator 排序
  分歧后均 APPROVE。focused 14/14、全部 release 146/146 与两轮 `pnpm workspace:check` 均通过。
- 修复已形成独立提交 `3272182` 并推送 GitHub PR #173；PR `workspace-check` 7m32s、
  `real-postgres` 15m1s、`runtime-app-macos` 均成功，状态 CLEAN/MERGEABLE。仓库要求 merge 单独
  明确授权，故在此权限点停止；远端继续保持 `stable / f276bdb / 0048`。
- 用户随后明确授权合并 PR #173，并授权后续既定任务自动执行、不再逐项询问；仍保留受保护主线、
  exact-SHA CI、两阶段发布、外部 provider 和真实证据分层等既有失败关闭门禁。
- PR #173 已以 merge commit `02b3883b9b5de1ea119bdcbe2f1ddde8cd9a0d4b` 合入；本地 `main`
  已 fast-forward 到同一 SHA。精确 push 级 Foundation `31604206437` 与 PostgreSQL
  Integration `31604206432` 正在运行，未提前发布。


## 2026-08-12：阶段 3.2–4.3 五批提交并进入 GitHub 保护流程

- 本地 `main` 已形成 5 个顺序提交：模型/契约 `a543c7a`、Server `de3e894`、Web `51dd631`、
  Web 边界拆分 `78d6c3f`、Cloud/验收 `aed724c`；提交前工作树与 diff-check 干净。
- 最终 `pnpm workspace:check` exit 0：lint 9/9、typecheck 12/12、build 9/9；Contracts 794、
  Domain 185、DB 81、Web 399、Server 906 pass + 90 opt-in skip、Edge 56、Cloud 275 pass + 1 skip。
- fresh PostgreSQL 完成 53 个迁移、ADR-45 5/5 和 catalog `1238 / b175abcb…70df8`；fresh Browser
  完成 commissioning 1/1、四条业务 journey 4/4。独立 TS/JS 审查 P0/P1/P2 为 0，DB 审查
  P0/P1 为 0。
- 直接 push `main` 被 GitHub 分支保护正常拒绝；同一提交历史已推到
  `codex/stage3-stage4-delivery` 并创建 PR #171，等待 `workspace-check` 与 `real-postgres` 后合并。
- 本轮不部署 hk-vps；受管 commissioning 容器/卷/network、测试浏览器和 5173/8543/8787 监听为 0。
  历史随机测试临时目录保持未读、未删除。

## 2026-08-12：阶段 4.3 设计审计与并行实现启动

- 代码、需求与安全三路审计确认当前只有件级生产/上挂/返工/异常，没有生产批次、四节点 custody、
  服务端清点差异或独立 QC 证据；因此不会把现有 `washing/ready/delivered` 冒充工厂交接状态。
- 实现边界冻结为同门店、在线、内部员工 Web/H5：外部工厂身份、跨店/跨组织 federation、照片/GPS/
  签名、离线与实体硬件后置。Contracts 目标为新增 5 写 2 读，冻结总面 58 commands / 38 queries。
- ADR/Contracts/Domain、0053/RLS/隐私导出与 Server 双后端已按文件所有权并行展开；主线随后负责
  Web 移动交接、Cloud/PG/Browser 验收、全工作区门禁与最终独立安全/数据库复核。
- 当前工作树仍包含阶段 3.2–4.2 的未提交成果；未获授权前不 commit、push、PR、部署或清理历史
  临时目录，也不会把本地软件证据表述成真实外部工厂/设备验收。

## 2026-08-12：阶段 4.2 最终关闭并切换至阶段 4.3

- 通知 pending 现在先于候选/模板等昂贵准备执行 store-scoped 风险容量检查；同一首跳
  idempotency key 直接复用冻结 authority 与服务端摘要。每店 active/rolling-24h pending 均限制
  100 张，HTTP 再按 session/org/store 限制 30 次/分钟，数据库限额仍是最终防线。
- PostgreSQL claim、续租、过期接管和结算全部改用 `statement_timestamp()`，应用时钟不再参与
  lease 授权；第 5 次崩溃、费用预留、隐私并发和回执乱序均由 fresh PG 覆盖。
- 最终 `pnpm workspace:check` exit 0：root 278/278、Contracts 785/785、DB 74/74、Web 392/392、
  Server 865 pass + 86 fresh-PG skip、Cloud 272 pass + 1 Linux-only skip，9 个包 lint/typecheck/build
  全绿。Edge SPA 以 `8f09f164…75b33` 内容寻址同步并通过 drift gate。
- fresh PG 完成 52 migrations、ADR41 3/3、ADR42/member/pending 31/31、ADR44 4/4，catalog 为
  `1116 / de12b277…be1311`；fresh Browser 完成 commissioning 1/1 与档案/会员/通知 3/3。
- 独立安全终审为 P0/P1/P2 全 0；精确 commissioning 资源、三个验收监听和测试浏览器均清零。
  历史 3 个无关卷与 73 个旧测试临时目录未获删除授权，保持不动且未读取内容。
- 阶段 4.2 仅以 `software_only` 关闭，真实 provider 继续 `blocked_external_provider`。当前按 1→5
  顺序进入 4.3 店厂交接、清点差异、质检/返工与移动交接证据。

## 2026-08-12：阶段 4.2 通知 outbox 实现与真实验收

- ADR-44 已冻结 1 写 3 读，Contracts 扩为 53 commands / 36 queries；0052 新增服务端模板、批次、
  delivery、只追加 attempt/receipt、RLS、费用/状态约束和顾客匿名化并发门禁。全新实例只在
  commissioning marker 落库时种入模板，普通组织维护不会产生隐式配置。
- memory/PG 双后端、30 秒有界租约、最多 5 次固定退避、稳定 delivery id provider key、乱序回执、
  72 小时人工降级和无网络零成本 fake adapter 已接入生命周期；未显式配置时保持 disabled。
- 催取 Web 新增管理员 capability、R3/R4 确认、批次/详情/成本和人工降级；请求不接受手机号、正文、
  provider URL 或 secret。软件模式只显示“模拟已接单（未发送）”，不会声称短信已发送或送达。
- fresh PostgreSQL 已完成 52 migrations、commissioning、ADR-41/42 与 ADR-44 真库回归、release
  catalog 0051→0052 write gate；fresh Browser 完成 commissioning 1/1 和会员/顾客/通知 3/3，
  精确 project、network、volume 和临时根由 harness 清理。
- Cloud API acceptance 新增只读 capability/batch/detail、严格负向命令和 `blocked_external_provider`
  证明，machine evidence 升级 v5；Cloud Chromium 只读子集接入通知面且继续禁止产品命令。
- 中间定向 Contracts 7/7、DB 35/35、Server 53/53、Web 4/4、Cloud 46/46 与相关
  lint/typecheck/build 已绿；最终 workspace、SPA 与独立复核结果见上方关闭记录。真实 provider 仍被
  凭据、模板、额度、网络请求和验签回执证据阻塞。

## 2026-08-12：阶段 4.1 Cloud 数据保护本地门禁

- ADR-43 的 root-only runner 已实现一致恢复集、共享 release lock 证明、操作/分动作失败状态、
  影子演练、网络文件系统离机复制、健康指标、systemd timer 与精确代码/DB/照片联合恢复；没有新增
  HTTP、Owner、Counter 或 Edge 恢复入口。
- 安全收口修复了生产 `pg_dump` 无法穿越 0700 staging、伪造 `--lock-held`、备份启动后健康失败、
  offsite 中间目录/文件替换、无外部证明误报健康、无关动作抹除失败、恢复准备回退不验健康、
  systemd 写面过宽，以及 commissioning/dump 清理静默失败。
- offsite 现强制 `nosymfollow`，用同一 no-follow FD 完成复制/权限/摘要/fsync 并重绑目录项；固定
  root-only authority 绑定实际 mount、非本机 failure domain、远端身份和时效。缺少真实 authority
  时状态固定为 `software_only` / `blocked_external_offsite` 且不健康。
- 定向测试 102 项中 101 通过、0 失败、1 项仅因 macOS 跳过；Linux-only 锁继承回归另在只读
  Linux 容器 1/1 通过，ESLint、Prettier、文件规模和 diff 全绿。全新 PG project
  `laundry-commission-pg-f9cb0591` 完成 51 migrations、commissioning、真实 Stage 3 回归及
  DB + 合成照片 backup/mutate/drill/recover，输出 `CLOUD_DATA_PG_ACCEPTANCE_OK`；精确 Docker、
  临时根、监听和浏览器进程清零。
- `pnpm workspace:check` exit 0：dependency audit high/critical 0、format、lint 9/9、typecheck 12/12、
  Foundation 278/278、Cloud 269 pass/0 fail/1 macOS skip、build 9/9。独立安全终审按最新树确认
  P0/P1/P2 全 0；真实 systemd 安装、offsite、告警接收、hk-vps 演练及 GitHub 交付仍未授权。
- 阶段 4.1 已按 `software_only` 关闭，当前进入 4.2 provider-neutral 通知 outbox；不会用 fake
  provider 冒充真实短信/微信发送、计费或回执证据。

## 2026-08-12：阶段 3.4 完成并切换至阶段 4.1

- 顾客档案 Web 已接通地址、标识、联系/服务偏好、R4 顾客折扣与订单折扣/等级/豁免权威展示；
  同批补回 ADR-41 等级 `discount_bps` 的 Web 编辑与 Cloud 旅程遗漏。
- 真实 Browser 首跑发现 `skip_ticket_print` 只拦 Server 入队、Web 成功页仍可直接调用浏览器打印；
  产品现按订单冻结 waiver 同时禁用两条打印入口并显示原因，回归覆盖该绕过。
- fresh-browser 完成 commissioning 1/1 与会员/顾客 Chromium 2/2；fresh-pg 完成 51 migrations、
  ADR-41 3/3、顾客/会员/pending 组合回归 31/31 及 0050/0051 release catalog/write gate。两个
  精确栈均在结束后清零，最终 catalog 摘要为 `6fd33bd…604b587`。
- 文件规模门禁推动 DB migration 测试和 Edge recovery entrypoint 测试按职责拆分；生产逻辑不变，
  DB 73/73、Edge scripts 56/56 与编译测试 404/404 通过。
- 最终 `pnpm workspace:check` exit 0：audit high/critical 0、format、lint 9/9、typecheck 12/12、
  Foundation 278/278、Contracts 780/780、DB 73/73、Server 833 pass/82 opt-in skip、Web 387/387、
  Cloud 199/199、build 9/9。SPA 以 `bd050a96…f9b557` 内容寻址同步，最终 drift check 通过。
- 独立只读安全终审覆盖隐私、锁序、RLS/GUC、离线复活、计价/豁免和照片保留边界，结论
  P0/P1/P2 全 0；精确 commissioning 资源、监听和浏览器进程归零。历史随机测试临时目录未经
  清理授权保持原状且未读取内容。
- 阶段 3.4 本地软件证据已关闭，现按用户要求进入阶段 4.1；PR、主线 CI 与 hk-vps 发布仍未获
  授权且未执行，不能用本地门禁冒充这些外部证据。

## 2026-08-12：阶段 3.4 Contracts、0051、Server 与真实 PostgreSQL

- Contracts 已冻结 52 commands / 33 queries；0051 实现组织级档案、地址/标识数据最小化、
  折扣/等级/三类运营豁免订单快照、递归 canonical group、通用 PII 副本清理与每组织 HMAC
  erasure tombstone。匿名化后的 direct/Edge 旧手机号写入统一终态拒绝并安全 ack。
- memory/PG 双后端已接入 profile CAS、标识搜索与冲突、顾客覆盖/等级自动折扣，服务端以整数
  基点向下取整并冻结来源；人工非零折扣优先，顾客 `0` 明确阻断等级继承，Edge 离线无法自行
  裁决动态顾客政策。
- 打印、标签、上挂按订单冻结的 waiver 失败关闭；隐私导出覆盖扩展档案和打印快照，匿名化同
  事务清理 address/identifier/service note、pending、idempotency、audit/replay 副本并阻断旧队列复活。
- fresh PostgreSQL 首轮发现旧并发探针等待已迁移到数据库函数内部的 SQL，更新探针后又捕获
  `min(uuid)` 不受 PostgreSQL 支持；改为确定排序的 UUID 数组首项。最终 51 migration
  apply/replay、commissioning、ADR-41 3/3 与 ADR-42 7/7 全绿，精确容器/network/volume/临时根清零。
- 为恢复文件规模门禁，已拆出命令结果、取衣 handler、顾客只读 PG 查询与 runtime identity
  构造；原超限文件降至 398/311/285/402 行，Server typecheck 与聚焦 eslint 通过。
- 当前下一步是顾客档案 Web 编辑、订单折扣/豁免可见性、Cloud API/Browser 合成旅程，随后运行
  全量格式/lint/typecheck/workspace 与独立安全终审；仍未获得 commit、PR 或部署授权。

## 2026-08-12：阶段 3.4 顾客扩展档案与政策启动

- ADR-42 与验收矩阵已在安全复核后重冻结：组织级多地址、车辆/标签/外部标识、联系与服务偏好、
  三类运营豁免、顾客覆盖及会员等级折扣；法律电子签署、地图/配送和复杂营销明确后置。
- 新面计划为 `customer.profile.get/set` 与 `customer.discount_policy.set`，freeze 目标 52/33；profile
  使用 CAS，PII 不进入普通 audit，搜索可匹配但不返回标识值。
- 自动折扣按整数基点作用于 original，优先级为非零管理员手工金额 > 顾客覆盖 > 未到期等级快照；
  订单冻结来源、基点、profile version 与打印/上挂豁免，既有订单不重估且优惠券不叠加。
- 独立只读复核确认 P0=0，但现有隐私基线有三组 P1：多跳/跨店 merge 孤儿、audit/idempotency/
  pending/replay 的持久 PII 副本，以及匿名化后旧离线队列复活手机号。0051 先以递归 canonical
  group、同事务 purge、每组织私钥 HMAC tombstone 和 Edge 终态 ack 关闭，再进入 profile 生产实现。
- 当前按 Contracts → 0051 → Server/隐私/计价 → Web/Cloud → 真库/Browser/workspace/复核推进；
  3.2/3.3 的 PR、CI 与 hk-vps 发布仍未授权。

## 2026-08-12：阶段 3.3 安全收口与真实验收

- 取消已核销券的 open 订单会在同一总线事务追加不可变冲正，保留原 redemption 并让同一券可在
  另一订单再次核销；取消/冲正/审计任一失败时订单和权益均回滚。
- active 等级/积分/次卡/券定义读取增加共享行锁；全部当前营业日会员写命令复用营业日锁与
  `SHIFT_CLOSED` 重查。定义审计保存完整规则快照，等级审计保留必填 reason。
- Web 命令现发送经校验 UUID 幂等 header，网络、5xx、`TRANSACTION_FAILED` 或
  `EVENT_DISPATCH_FAILED` 后同请求保留原键，确认续跑也沿用第一跳键；Server 拒绝 header/body 漂移。
- 全新隔离 PostgreSQL 已完成 50 migration apply/replay 与 ADR-41 3/3；fresh-browser 投产 1/1、
  精确会员 Chromium 1/1；Cloud 工具 198/198、Web command client 7/7。每个精确临时栈的容器、
  network、volume、私有目录、浏览器进程和监听均归零。
- 独立安全终审确认 P0/P1/P2 均为 0；精确 A/B/C/D 与 fresh commissioning 项目的 Docker、路径、
  监听和浏览器残留复核均为 0。
- 首轮 `workspace:check` 在 Edge SPA drift 门禁发现手工 Web build 使用陈旧 contracts 产物；已让
  `spa:verify` 通过 Turbo 先构建 Web 及其依赖，并更新门禁断言。独立 Edge 403/403 与 SPA check
  通过，第二轮全仓门禁 exit 0：audit high/critical 0、lint 9/9、typecheck 12/12、Foundation
  278/278、Contracts 772、DB 72、Server 812 pass/74 opt-in skip/0 fail、Cloud 198/198、build 9/9。
- 阶段 3.3 本地实现与门禁完成，当前按 1→5 顺序进入 3.4；PR、CI、hk-vps 发布仍未授权。

## 2026-08-12：阶段 3.3 契约、0050 与双后端核心

- ADR-41 与阶段验收规格已冻结 6 个命令、2 个查询：会员等级、服务端权威积分、次卡和固定额券；
  会员有效期不没收既有储值本金或赠款，实体卡/provider/跨组织转赠继续后置。
- Contracts 已扩为 50 commands / 32 queries，所有输入为严格 Zod 边界；浏览器不能提交积分奖励值
  或券抵扣金额。0050 新增 12 张组织 RLS 表、定义 CAS、不可变积分/次卡流水、券核销与冲正约束。
- Server 已接入 memory 与 transaction-scoped PostgreSQL store；积分按结清订单幂等奖励并 FIFO
  消耗，次卡并发串行，券与同顾客未付款订单在同一事务内抵扣，命令审计和领域事件继续由总线同事务写入。
- Contracts、DB 静态门禁、Server typecheck、内存权益 4/4 与运行时接线定向测试已通过；当前补齐
  真实 PostgreSQL 事务/RLS 回归、Web 操作面、Cloud API/Browser journey，再运行 workspace 总门禁。

## 2026-08-11：阶段 3.3 会员权益启动

- 已审计 ADR-17/18/22/25 与当前 `member_accounts/member_ledger`：储值开户、充值赠送、
  余额核销、本金退款、冻结/解冻/关户已存在；等级、积分、次卡、券与资产有效期仍未实现。
- 本片不让会员有效期没收储值本金/赠款；有效期只作用于虚拟等级和独立权益资产。实体卡、
  支付机构、跨组织转赠、自动双账户合并继续后置。
- 券只采用服务端固定金额快照，并在同事务内核销到同顾客的未收款订单；积分只按已结清订单
  与服务端政策计算，浏览器不提交优惠金额或积分数。
- 当前下一步：落档 ADR-41 与验收矩阵，再按 Contracts → 0050 → Server → Web/Cloud 实现。

## 2026-08-11：阶段 3.2 Owner 实现与门禁

- ADR-40、44/30 契约冻结、0049 migration、授权门店目录与当前门店名称 R5 CAS 已完成；
  会话显示、刷新、员工目录、账目与 Owner 报表均按认证会话门店读取。
- Owner Web 已形成“今日 / 经营报表 / 门店管理”三页，复用 ADR-24 报表和既有员工 R5 治理；
  切店先注销，只预填 org/store，用户名和密码保持为空。
- Cloud API acceptance 新增可补偿的门店改名纵向，Cloud Browser 新增独立 Owner context 的
  只读三页旅程；定向 Cloud 工具 197/197、Web 定向 12/12 通过。
- 独立 PostgreSQL 16 空卷已完成 49 个迁移、replay 与 legacy→current；Owner 真库 2/2 证明
  未授权门店过滤、无 UUID 投影、CAS 1→2、陈旧写失败、单条审计，以及非 bootstrap 门店
  login/display/staff/store/refresh/logout。
- 安全审计发现非 bootstrap 会话可到达仍在启动时绑定 `LOCAL_PROFILE` 的旧柜台依赖。已新增
  Owner bus 显式白名单，并对照片、打印和 Edge 路由失败关闭；Server typecheck 与完整内存
  测试（仅显式 PG 用例 skip）通过。
- 非首店密码登录、refresh、Bearer 与 PIN quick switch 现统一要求 active admin；R5 approver
  按当前 org/store 解析，员工目录带 `no-store`。聚焦安全复核确认 P0/P1/P2 均无残留。
- 最终 `pnpm workspace:check` 全绿：依赖审计 high/critical 0、format、9 package lint、12 task
  typecheck、全部测试、Cloud 197/197、9/9 build 与 SPA sync 通过；`git diff --check` 通过。
- 隔离真库最终 2/2 通过，首跑唯一失败是测试清理漏删 `command_idempotency`，补齐清理后复跑
  成功；两轮精确容器、volume、私有配置和临时 runner 均无残留。
- 阶段 3.2 本地实现与门禁完成，当前按用户 1→5 顺序进入 3.3 缺口审计与 ADR；PR、CI、
  hk-vps 发布及真实公网 Browser 仍未授权且分别保留 pending。

## 2026-08-11：ADR-37 后续 1→5 顺序实现启动

- 用户要求按上一轮列出的 1→5 依次实现；固定顺序为 Owner 公网经营与门店管理 → 会员增强 →
  顾客扩展档案 → 大型云端模块 → 后置桌面/硬件/真实迁移门禁。
- 已完整读回 `task_plan.md`、`progress.md` 与 `findings.md`，并订正旧的阶段 3.1 在途状态：
  PR #169、hk-vps `f276bdb…fdca`/0048 发布、PR #170 文档回写及 `main=1c25dfd…9407`
  精确主线 CI 均已完成。
- 当前严格进入阶段 3.2 的需求与代码审计；不提前实现会员增强或阶段 4。
- 本轮用户授权实现与测试，但没有授权 commit、push、merge、删除分支或远端发布；达到交付点时
  另行报告和确认。
- hk-vps 22 端口可达，但严格 ED25519 keyscan 连续失败；在恢复指纹核验前不执行 SSH 或发布。
- 当前下一步：读取活动 ADR/产品规格，追踪既有 Owner Dashboard、组织内授权门店组合、报表、
  staff/store 管理和公网会话路径，形成 3.2 精确缺口与 ADR 草案。
- 3.2 审计已完成：公网请求安全链可复用 ADR-36，但 Owner IA 仍停留在 LAN 只读；ADR-24 报表
  可直接复用，缺口集中在公网 Owner 导航、授权门店目录、当前门店受限资料写入，以及
  PostgreSQL 会话/员工目录对 `LOCAL_PROFILE` 的硬编码。
- 已冻结实现方向：Owner 增加今日/报表/门店三个产品页；报表复用既有双口径查询与 R3 导出；
  新增授权门店列表与当前门店名称 R5 CAS 更新，员工治理复用既有 R5 命令。跨店管理先注销并
  按目标门店代码重新认证，不接受客户端 org/store 作为命令租户。
- 当前下一步：落档 ADR-40、契约冻结与 3.2 验收记录，然后按 Contracts → Server/Auth → Web →
  Cloud harness 顺序实现。

## 2026-08-11：阶段 3.1 价目治理批次

- 阶段 2 已由 PR #167 合入，并以精确 merge SHA
  `6f106076018940eec8fcc9e8c2cfb7842c323f47` 完成 hk-vps 两阶段发布；发布结果由
  docs-only PR #168 回写。当前基线 `main=origin/main=86d7a6f61ab24843501332c1d86179e8b8067806`。
- 用户授权接续下一批 1→5，当前切片冻结为：审计/ADR → DB/Contracts/Server/Web →
  真实 PostgreSQL/Browser/总门禁 → GitHub 交付 → 精确 SHA 云端发布与验收。
- ADR-39 与 `0048_catalog_governance.sql` 已实现价目乐观版本、停用恢复、全量活动项原子排序，
  并新增只展示安全字段的 catalog 审计查询；冻结清单更新为 43 commands / 29 queries。
- Web 设置页已显示活动与停用价目，支持编辑、停用、重新启用、上下排序和并发冲突；Cloud
  harness 已加入相同 API 纵向，历史订单继续读取不可变价格快照。
- 新鲜定向证据：Contracts 763/763、DB 70/70、catalog handler/store 7/7、Cloud 27/27；
  真实 PostgreSQL catalog acceptance 已证明 0047→0048 与 golden policy，完整 Server
  852/852、0 failed、0 skipped；Chromium 完整 17/17。
- 最终内容的 `pnpm workspace:check` exit 0：format、lint、typecheck、全部 workspace 测试、
  Cloud 196/196 与 9/9 build 全绿；Edge SPA 内容寻址 bundle 已同步且 drift check 通过。
- 当前进入提交前独立复审；复审无阻断后才提交、推送和创建 PR。

## 2026-08-11：阶段 2 三个核心切片启动

- 用户明确要求 1→2→3 依次开发测试，三个切片完成后部署 hk-vps。
- 本批顺序固定为：服务端权威计价与设置生效 → 支付流水与退款 Web → 衣物详情与挂单恢复。
- 按 `planning-with-files-zh` 完整读回既有 `task_plan.md`、`progress.md` 与 `findings.md`；
  旧计划中阶段 1 的 `in_progress` 已按新鲜发布证据订正为 completed。
- 新鲜基线：`main=origin/main=86458562b58b671624310616a1d396e6f4bb5f4e`，工作区干净，
  open PR 为 0；该 docs-only main 的 Foundation `31459664193` 与 PostgreSQL Integration
  `31459664181` 均成功。
- 已部署运行 marker 继续是 `7989206b3e9748b2a607687466ef2e0775ad528e`；阶段 2 开发不在
  VPS 直接改代码，最终只部署合入主干且精确 CI 全绿的 merge SHA。
- 用户要求三个切片完成后统一部署；因此每个切片保留独立实现/测试 checkpoint，最终使用
  一次集成 PR 和一次两阶段云端发布，不在切片中间反复切换 hk-vps。
- 当前进入 2.0/2.1 只读架构审计与契约冻结，尚未修改生产代码。
- 2.0 已完成：新增 ADR-38，精确冻结 store-scoped 计价策略、服务端金额解析、
  `payment.ledger.list`、双管理员退款 Web、件级明细、持久挂单恢复及 `0046 -> 0047` 代码
  回滚兼容边界；`m2-freeze.test.ts` 将在实现中点名 42 commands / 27 queries。
- 当前进入 2.1，实现前先以合同/服务端负例固定“伪造金额无效、未知附加项失败、非管理员
  折扣拒绝、设置版本与订单快照一致”。
- 2.1 已完成契约、`0047` expand-only schema、store-scoped pricing repository、R5 双管理员
  设置 UI、服务端权威定价和开单 UI。旧 `addon_cents/urgent_cents/freight_cents` 仅兼容解析且
  被忽略；非零折扣要求 admin-only `order_discount`，订单保存政策版本、固定费选择和件级附加项。
- 新鲜内存门禁：Web build/typecheck 与 354/354 测试通过；Server 内存套件此前 838 项中
  769 passed、69 条 PG 明确 skipped，Contracts 760/760、DB 69/69 均通过。
- 独立临时 PostgreSQL 16 环境完成 47 个迁移且迁移双跑通过；完整 Server 真库套件
  838/838、0 failed、0 skipped，`PG counter workday` 证明伪造旧金额不生效、政策快照与真实
  账本一致。升级后的 Playwright 柜台工作日 1/1 通过，覆盖 R5 设置、政策选项、请求体边界、
  权威应收、部分收款和取衣补款。
- 首次临时栈使用 `/tmp` 时在配置校验前失败，因为 macOS `/tmp` 是符号链接而密钥配置路径
  明确拒绝 symlink ancestor；改用 `/private/tmp` 后通过。两次尝试均已反向确认无阶段 2.1
  容器、volume 或私有配置目录残留。
- 当前进入 2.2：新增只读支付流水投影，接通订单详情中的原付款选择与既有 R4 双人退款；
  完成内存、真实 PG 与 Browser checkpoint 前不进入 2.3。
- 2.2 已完成：新增 bounded `payment.ledger.list`，服务端从不可变流水统一推导正负金额、
  active 与剩余可退额度；Web 只允许管理员从服务端返回的原流水发起退款，不提供 UUID 文本入口，
  R4 续跑只发送冻结的 `confirm_ref`。订单详情控制器已拆分，活动生产文件均低于 400 行。
- 新鲜定向证据：Domain 181/181、Server 流水查询 4/4、Web 相关 27/27、Web build/typecheck；
  独立 PostgreSQL 16 上迁移 47 项双跑、PG workday + 流水查询 5/5；Playwright 柜台纵向 1/1，
  覆盖 ¥10 原收款、¥2 退款、另一位店长 PIN、原流水剩余可退 ¥8、欠款 ¥32 与最终取衣结清。
- 首轮 Browser 运行产品行为已成功，唯一失败是测试选择器把“含退款按钮的收款行”也按“退款”
  匹配；收紧为行首类型后复跑通过。两轮临时 Compose project、volume 与 `/private/tmp` 配置均清理。
- 当前进入 2.3：衣物颜色/品牌/瑕疵/附件/件级备注输入与持久挂单召回；完成对应 checkpoint
  前不进入最终集成门禁、提交或云部署。
- 2.3 已完成：新 Web 对每一件衣物独立编辑颜色、品牌、瑕疵、随衣附件、件级备注和附加项；
  `order.get` 返回完整订单/草稿明细及正式 garment 属性。开单页以有界 `order.list(status=draft)`
  召回，再用 `order.get` 校验仍为未收件 draft 后恢复；硬刷新会按既有安全设计清空 renderer
  会话，重新登录后仍可从 PostgreSQL 恢复，不使用 localStorage。
- 新鲜定向证据：Contracts 762/762、Web 360/360、服务端订单详情/计价 8/8、Web/Server
  typecheck 和 diff-check 通过；独立 PostgreSQL 16 上 47 条迁移双跑、PG workday 1/1，
  Chromium 柜台纵向 1/1，覆盖逐件差异、暂存、硬刷新、重新登录、完整恢复、权威开单、
  R4 双人退款与取衣结清。首次浏览器运行错误假定刷新后 renderer 仍有会话，按安全边界改为
  明确重新登录；失败栈与复跑栈的容器、卷、私有配置均已清理并核验零残留。
- 当前进入最终集成门禁与提交前终审；完成前不提交、不推送、不部署。
- 最终集成候选已完成 `pnpm workspace:check`，依赖审计 high/critical 为 0，format、lint、
  typecheck、全部测试与构建全绿；Contracts 762/762、Domain 181/181、Web 最终 367/367。
- 第二套隔离 PostgreSQL 16 验收从空卷应用 47 条迁移并重复 reconcile；完整 Server
  848/848、0 failed、0 skipped，commissioning 与 golden catalog 通过；Chromium 17/17，
  容器、网络、卷和私有配置均按精确 ownership 清理并核验零残留。
- 完整 Browser 首跑揭示取消订单仍保留原应收、但支付/欠款投影必须归零；严格客户端解析器
  已按该领域语义修复并补回归，随后 Web 367/367、lint、typecheck 与 SPA 校验全绿。
- 当前进入提交前差异自审；完成后才创建候选 commit、PR 并等待 required CI。
- 提交前自审覆盖契约/权限、金额权威、事务与审计、严格解析、异步失败、文件规模、迁移兼容、
  生成 SPA、敏感信息与残留资源；已关闭审查中发现的问题，最终无 80% 置信度以上阻断项。
  临时审查报告复核后已删除，当前开始对最终内容重跑全仓门禁。
- 最终内容的 `pnpm workspace:check` 已再次 exit 0：依赖审计 high/critical 为 0，format、
  lint、typecheck、全部 workspace 测试、Cloud 196/196 与 9/9 build 全绿；Web 367/367，
  生成 SPA 再同步后仍为同一内容摘要。当前进入候选 commit 与 GitHub PR。

## 2026-08-10：切换为云端 Web 剩余功能优先

- 用户明确后续主要以云服务器部署的 Web Server 为产品形态，在此基础上继续剩余功能开发与测试；Windows 等软件暂不做。
- 当前 `main=origin/main=6609c5e`、工作区起始时干净；阶段 1 macOS 软件面与阶段 2 打印软件链已合入，但它们不再决定后续功能顺序。
- 已使用 `planning-with-files-zh` 将当前执行真源改为云端 Web：先审计设计/代码/公网验收缺口，再冻结实现 backlog。
- 本轮审计期间不修改 hk-vps 服务或数据，不把历史 API harness 结果当作当前公网浏览器 UI 证据。
- 阶段 0 只读审计完成：`main=origin/main=6609c5e`，push 级 Foundation 与真实 PostgreSQL CI
  均通过，无 open PR；open #147–#151 全是 ADR-36 验收事项，不是新增产品功能 backlog。
- hk-vps 服务、Caddy、TLS、SPA 与 loopback PostgreSQL 当前健康，但 marker 仍为 `ae9808c`、
  migration head 为 0045、SPA 亦为旧 bundle；部署比 main 落后 10 个提交，尚不能作为当前代码证据。
- 当前 41 commands / 25 queries 已覆盖大部分核心店务；云 HTTP harness 单测 32/32 通过，
  但远端浏览器 UI、历史催取 fixture、照片/治理/Owner 等更广产品面仍需分层验收。
- 真正优先的产品代码缺口冻结为：计价设置与服务端权威、支付流水/退款 Web、衣物详情与挂单
  跨刷新恢复。完整会员、真实通知、店厂协同排在其后；AI、小程序、取送营销、通用 SaaS 与
  远程打印 Edge 不进入第一批。
- 本轮未部署、未重启、未写云数据库；只更新被 `.git/info/exclude` 排除的内部计划文件。
- 用户随后明确批准按审计结论 1→4 依次实施。计划已重排为：阶段 1 云基线、阶段 2 核心
  店务缺口、阶段 3 第二批增强、阶段 4 后续大模块；每阶段单独通过代码审查、真实 PG、
  公网浏览器、PR required CI、merged-main CI 与精确 SHA 云验收后再进入下一阶段。
- 阶段 1 已在 `codex/cloud-web-roadmap` 完成 ADR-37 与状态文档初稿、30/90/180 天受控历史
  fixture、只读公网 `core_ui_subset` 及两阶段 hk-vps 发布工具；尚未提交、推送或部署。
- Browser 子集已改成零产品命令、零业务清理且没有独立关闭权；4/4 边界测试、Web
  typecheck/lint 与 Playwright 非 opt-in skip 通过，完整业务纵向仍由 API acceptance 负责。
- 新发布入口的 read-only `status` 已在 pinned key-only SSH 下返回 `phase=stable`；临时
  known_hosts 已清。远端容量只读盘点为约 32.6 GB 可用、live tree 835 MB、DB 13 MB。
- 发布安全/数据库终审发现 flock、umask/marker、backup root、停写会话、shadow/catalog
  proof、强制 finalize evidence、SSH host-key pin、容量/保留与秘密环境隔离缺口；当前逐项
  修复并补回归，未达到可部署状态。
- required `real-postgres` workflow 已新增发布 catalog 真库探针，直接复用 source/shadow
  `CATALOG_SQL` 与严格 parser；只有两个精确 opt-in 同时启用才连接隔离本地 PostgreSQL，
  focused 5/5、ESLint、Prettier 与 diff-check 已通过；独立 PostgreSQL 16 栈完成 46 migrations
  后真实返回 666 条 catalog evidence，测试容器、网络、精确 volume 与临时配置均已清理。
- VPS 只读凭据盘点确认 `/etc/laundry-desk/adr36-acceptance.env` 与
  `/etc/laundry-desk/acceptance-secrets` 尚不存在；现有 root-only `server.env` 具备 admin
  直接字段、approver `_FILE` 路径和 DB admin URL。发布工具现会在远端以不回显方式生成并
  核对 9 个 release-only secret files；`finalize` 只把其中 8 个浏览器字段下载到本地随机
  `0700` 目录，白名单环境运行后无论成败都清理。尚待真实部署验证该 materialize/download。

## 2026-08-09：后续 1–6 顺序交付启动

- 用户明确授权按上一轮后续 1–6 顺序完成、测试、提交并推送 GitHub `main`。
- 当前先执行阶段 0：集成已经完成并终审通过的 P0–P2 工作树；后续阶段不提前写入。
- 使用 `planning-with-files-zh` 维护长任务状态，提交使用仓库 `git-commit` 日志规范。
- 外部硬件、Developer ID/notary、Windows 实机和生产/provider 授权仍是实证门禁，缺失时
  不以模拟或 CI 冒充通过。
- 阶段 0 新鲜门禁：`pnpm run workspace:check` exit 0；独立临时 PostgreSQL 完成 45 个迁移、
  双管理员 bootstrap 与 Server 828/828、0 failed、0 skipped。精确测试容器、卷和私有配置
  目录均已清理。
- 阶段 0 已拆为 `2a9293e`（统计/照片真库证据）与 `e269731`（ADR-36 公网验收证据）两笔
  提交。GitHub 受保护 `main` 拒绝直接推送，已按保护规则创建 PR #153；Runtime macOS
  检查已成功，workspace 与 real PostgreSQL 检查仍在运行，尚未提前进入阶段 1 写入。
- PR #153 三项检查全部成功（Runtime macOS 4m24s、workspace 4m51s、real PostgreSQL
  11m24s），已合并为 `main=5f1c3f7`，#152 自动关闭。阶段 1 从新分支
  `codex/macos-current-web` 开始。
- 合并提交 `5f1c3f7` 的 push 级 Foundation 与 real PostgreSQL 也分别成功；后者 11m49s
  完成全部迁移、恢复、commissioning、Server 0-skip 与 Playwright 段。阶段 0 远端闭环完成。
- 阶段 1 已新鲜通过 `local:acceptance`（Browser 17/17、打包 Counter 7/7）、
  `local:commissioning:fresh:mac`（1/1）以及 Runtime.app 托管真实 Server OCI 与打包
  Counter 的 install/stop/start/restart 组合验收；Runtime 最终标记为
  `assurance=software_only runner=system ... cleanup=clean`，固定端口、验收进程、容器、卷、
  临时密钥与 lease 均已反向确认清理。
- 阶段 1 最终 `pnpm run workspace:check` exit 0：依赖审计 high/critical 为 0，format、
  lint 9/9、typecheck 12/12、测试 12/12、build 9/9，Node 本地与 Runtime 276/276；
  Counter、Runtime 集成与安全独立终审均放行。稳定差异的最终 TypeScript 审查和
  silent-failure/false-green 专项审查也均为 APPROVE。当前只剩分组提交、PR 与 `main`
  required CI。
- 阶段 1 拆为 `0158b67`（macOS 当前产品面）与 `435de16`（Runtime 托管组合）两笔提交，
  PR #154 的 workspace、Runtime macOS、real PostgreSQL 分别以 6m19s、3m19s、12m23s
  通过；保留两笔提交后 merge 到 GitHub `main=7e72b57`。
- `main=7e72b57` 的 push 级 V2 Foundation 再次通过（workspace 6m03s、Runtime 3m53s），
  V2 PostgreSQL Integration 12m01s 通过全部迁移、恢复、投产、Server 真库 0-skip 与
  Playwright 并完成 Compose 清理。阶段 1 正式 completed，开始阶段 2 XP-58/CUPS 实机盘点。

## 2026-08-09：P0–P2 云端 Web 产品收口

- **状态：** safe_scope_completed；历史催取 fixture 与远端浏览器 UI 等待明确授权
- 用户授权执行前一轮建议中的 P0–P2。
- 已加载 `hk-vps-ops` 与 `planning-with-files-zh`，读完既有计划、进度与发现。
- 既有 `task_plan.md` 记录的 ADR-36/#143 工作已完成；本轮改为 #144 部署、当前路线、
  云端产品验收与真实 PostgreSQL 技术债收口。
- 未获得 commit/push/merge/delete 授权，本轮先完成实施与验证，Git 交付另行确认。
- **P0 completed：** `main=origin/main=ae9808c`；Foundation `31309919969` 与 PostgreSQL
  Integration `31309919975` 成功。hk-vps marker 精确绑定该 SHA；公网/loopback health、
  login、refresh、protected query、合成 customer 写入回读与 logout 全绿，认证负例对外等价，
  KB、PostgreSQL loopback、Caddy/systemd 无回归。GitHub #145 已关闭。
- **P1 completed：** 建立 milestone #7 与 #145–#152；README、ADR 索引、历史计划/验收订正、
  新活动计划/验收记录和外部 KB 已同步。旧 milestones #1–#6 只保留历史，不删除。
- 云库 legacy 单管理员已通过一次性 root-only commissioning 收敛为 2 位 active admin；第二位
  管理员秘密只保存在 VPS `0600` 文件，服务配置只引用 `_FILE`，没有 HTTP owner 旁路。
- **P2 真库 checkpoint：** 新增 stats 现金合成与 photo 引用/孤儿清理证据；首次运行暴露并修复
  macOS 临时目录 symlink 边界。定向 7/7，完整 Server 真 PostgreSQL 828/828、0 skipped；
  隔离容器、卷和配置已清理。独立数据库与 TypeScript 复审正在收尾。
- 数据库复审补强后第二次完整隔离真库仍为 828/828、0 skipped：新增同组织异门店 50,000 分
  现金干扰仍不进入当前门店钱箱；`photo.register`/`photo.delete` 在对应 audit trigger 强制失败时
  分别证明 metadata 回滚/保留。统计与照片随机 fixture 均在 finally 清理，隔离容器、卷、配置再度清空。
- **P2 云验收进行中：** 新建独立 VPS/API harness，不复用会覆写共享 PG 的本地 Playwright
  setup；当天交班与 30/90/180 天催取时光 fixture 仍保持明确 blocked，不伪造通过。
- cloud harness 已拆为 6 个均低于 800 行的模块，10/10 单测、lint、format、syntax 通过；任何
  `__Host-* Domain`、复用双管理员凭据或非 UUID step-up proof 均失败关闭，预期缺口输出
  `overall BLOCKED PARTIAL_ACCEPTANCE_ONLY` 和 exit 2。
- 首轮最终 `workspace:check` 在 foundation 精确脚本门禁发现 2 个接线失败：cloud test glob
  插入既有 `workspace:test` 命令破坏了默认门禁字符串契约；现已保持冻结命令不变，并把 cloud
  lint/test 作为独立步骤接入。最终 `workspace:check` 全绿：基础 231/231、cloud 10/10、全部
  workspace test/typecheck/lint/build 通过。
- 公网验收先后暴露两个 harness 契约误判：同秒 refresh JWT 可相同，以及 PG 价目只投影 active
  记录且不返回 `is_active`。两者均先补回归再修正，独立 TS reviewer APPROVE。
- 最终公网 run `ADR36-20260809T124329952Z-7b81947d`：双管理员、账务基线、价目、合成顾客、
  现金订单履约、会员生命周期、今日账务增量、清理与登出均 PASS；催取历史与当天交班按设计
  BLOCKED，overall 为 `BLOCKED PARTIAL_ACCEPTANCE_ONLY`。运行后 marker/四服务/desk/KB health、
  PG loopback 与 VPS 临时目录均复核正常。
- 扩展公网旅程补齐员工创建/凭据完成与重置撤权、错误条码零副作用、价格快照、独立欠款补缴、
  R4 退款/重放、日/月/职员账务与 CSV、固定窗口历史空日交班/重放。首轮暴露旧 refresh 被拒时
  清 Cookie 的正确浏览器语义，先补回归再修正。
- #150 逐条复核发现冻结状态只验了状态、未真实拒绝资金操作；现用同一笔有效余额支付证明
  冻结时 `INVARIANT_FAILED` 且账户/订单快照零变化，解冻后同输入成功。另修复订单财务 cleanup
  不得覆盖基础旅程 post-commit uncertainty；cloud 单测 21/21。
- 最新公网 run `ADR36-20260809T133001270Z-0c02dde5`：除 `reminder_history BLOCKED
AUDITED_TIME_FIXTURE_REQUIRED` 外全部旅程、safe cleanup 与 logout PASS；overall 按失败关闭为
  `BLOCKED PARTIAL_ACCEPTANCE_ONLY`。清理后 marker 未漂移、四服务 active、failed units 0、
  desk 内外 health 200、KB health 跟随重定向 200、PG 仅 loopback、VPS 临时目录 0。
- 最终结构/安全加固把 Cloud 生产文件全部拆到 400 行以内、测试全部低于 800 行，并将该规则
  纳入 ESLint；认证响应严格校验完整 Web 合同，Cookie/CSRF、logout 撤权、远端错误码脱敏与
  post-commit uncertainty 均有失败关闭回归。Cloud 回归 32/32。
- live 最终复跑先暴露 refresh 正常轮换不递增 `session_version` 的 harness 误判；按服务端、契约
  与真实 Web 客户端证据改为同 session/version/permission，补版本漂移负例。最终公网 run
  `ADR36-20260809T141222752Z-f6c5d218` 除历史催取外全 PASS，safe cleanup/logout PASS；marker
  精确为 `ae9808c`，四服务 active、failed units 0、desk/KB 200、PG 仅 IPv4/IPv6 loopback、
  VPS 验收临时目录 0。
- 最终终审另发现并修复：员工停用响应不得先于旧 bearer/refresh/password 复核标记 cleanup
  成功；无 Content-Length 的 HTTP 响应必须流式限制 1 MiB；照片真库 fixture 的 rollback/drop
  清理失败不得覆盖首因。对应回归通过，TypeScript、数据库、安全三路终审均 APPROVE，P0–P2 为 0。

## 2026-08-09：ADR-36 hk-vps 云测试环境收口

- **阶段 1–3：completed。** 登录 401 根因是旧 smoke 缺少严格契约要求的 `device_id`
  UUID；公网与 loopback 登录均已 200。refresh/CSRF cookie 轮换、受保护查询与一条合成客户
  写入/读回全绿，PostgreSQL 仍只监听 loopback。Claude 的 public-origin 配置、测试与 ADR
  已从当前 `main=661f4e2` 精确移植，不合入其分叉历史。
- **阶段 4：completed。** `LAUNDRY_PUBLIC_ORIGIN` 与 ADR-32 LAN origin 严格互斥；新增
  lifecycle 回归、ADR-36、CHANGELOG、README 路线和 hk-vps 运维手册。两次
  `pnpm workspace:check` 均 exit 0；基础 229/229、全包测试/构建 12/12 与 9/9。
- 隔离真实 PostgreSQL 门禁完成：45 迁移首次应用、第二次全识别、bootstrap 从 created
  收敛为 unchanged、RLS smoke 全绿，Server 823/823 且 skipped=0。测试容器、卷、0700
  配置目录和日志全部清除。
- **当前：阶段 5。** 提交前只读审计后创建候选 commit，再按该精确 SHA 部署 hk-vps。

## 2026-08-08：P6 新店投产与正式候选闭环

### 阶段 0：基线与设计边界

- **状态：** completed
- 已使用 `planning-with-files-zh` 重建并落盘 P6 1→5 计划；提交阶段将按 `git-commit` 规范执行。
- 已刷新 GitHub：`main=origin/main=014b5f1`、无开放 PR、主线 Foundation 与真实 PostgreSQL
  workflow 全绿；创建 `codex/p6-store-productionization`。
- 当前并行只读审计 commissioning 契约、安全权威、PostgreSQL/RLS、Web/Electron 和空卷 E2E；
  下一阶段生产实现尚未开始。
- ADR-31 已冻结 Runtime 双管理员一次性投产、核心 feature profile、R5 员工元数据命令与
  creator-bound 凭据完成边界；合同、0045、Runtime 与 Web 三路开始实现。

### 阶段 1：空卷首次投产闭环

- **状态：** completed
- 已建立 contracts/DB/server、Runtime/bootstrap、Web/Electron 三组互斥文件所有权；生产实现
  严格限定在 Stage 1，尚未开始 Stage 2。
- Contracts、0045、员工创建/凭据重置与完成路由、双管理员 bootstrap、Runtime commission、
  Web/Electron 设置界面均已达到可编译和定向测试绿的 checkpoint；正在收敛真实 PG、空卷
  Browser/packaged macOS 与旧卷升级兼容。
- 集成审查发现并处理中：PG fixture 不能复用第二管理员 ID；基础 upgrade readiness 与
  commissioned business readiness 必须分层，避免旧卷升级死锁。
- 真实 PostgreSQL 首轮揭示 bootstrap audit 复用参数时混用 `uuid`/`text`；已统一显式
  类型并用 fresh build 通过。员工生产链 1/1、0 skip，覆盖创建、creator-bound 完成、
  登录、重置撤权、过期重发、跨租户/CAS/最后管理员和无秘密审计。
- readiness 已冻结为双函数：既有 boolean 仅证明 operational bootstrap；新增 tri-state
  函数区分 `commissioned`、严格单管理员 legacy 的 `commission_required` 与 `invalid`。
  真实 PostgreSQL 已将 commissioned fixture 事务内还原为 legacy 并精确得到
  `commission_required`，随后回滚且无残留。
- 三套独立投产证据已完成：真实 PostgreSQL 旧卷从 0044 升级并一次性 commission；Browser
  新卷从生产 bootstrap 开始完成员工生命周期；packaged arm64 macOS `.app` 在另一新卷完成
  同一流程。三者均验证两位管理员与严格 commissioned 状态并自动删除隔离容器、卷和临时目录。
- 数据库终审项已实测关闭：reset/complete 通过统一 advisory transaction lock 串行化，三连接
  回归无死锁；最小 SECURITY DEFINER 撤权函数在 FORCE RLS 下清除目标员工全组织各门店的
  session/family/token，非管理员和跨组织调用均失败关闭。DB 67/67、真实 PG 2/2，Server
  typecheck/lint/build 全绿。
- 独立 TypeScript、数据库与安全终审均 APPROVE，最终 P0–P2 为 0；Stage 1 关闭并严格切入
  Stage 2 Runtime 无仓库 LAN 运维整合。

### 阶段 2：Runtime 无仓库运维整合

- **状态：** completed
- 已完成只读架构盘点：复用签名 Server OCI 内的 Node 网关实现，不要求目标 Mac 安装
  Node/pnpm；Runtime 只管理严格私有的 LAN profile、证书/密钥、Compose overlay、启停、
  onboard/diagnose 和脱敏 support bundle，Fastify/PostgreSQL 继续只绑定回环地址。
- Runtime manifest v2 已绑定 LAN Compose 与 Owner SPA 摘要；Server OCI 内嵌固定网关和 SPA，宿主无需仓库、Node 或 pnpm。
- Runtime.app 已接入 configure/enable/disable/status/onboard/diagnose/support，严格校验 RFC1918 接口、高端口、IP SAN、证书时效、密钥匹配与固定七路由。
- 8787/8543 继续 loopback；LAN 网关仅以受信 HTTPS 暴露 Owner 冻结面。同地址换证、plain disable→enable、reconfigure→enable 均已在真实 Docker 验证。
- backup/restore/commission/upgrade/rollback 统一捕获 LAN intent；变更开始后失败保持 Server/gateway 停服，stop/state 失败进入耐久 physical/state uncertain，不伪报 disabled。
- 组合 `runtime:app:acceptance` 单次构建后通过 Native 73/73、manifest 负例 8、LAN 34/34、maintenance 16/16，结束时测试签名私钥无残留。
- 真实容器中 Server/gateway Healthy、Playwright 3/3、LAN 边界拒绝、8787/8543 隔离及资源清理全绿。独立终审 forced typecheck 12/12、lint 9/9，P0–P2 为 0，结论 APPROVE。

### 阶段 3：可携带数据保护

- **状态：** in_progress
- ADR-33 已冻结 03:00 定时备份、有界留存、1 MiB 分块 AES-256-GCM、PBKDF2-HMAC-SHA256、严格外部路径与 pre-transfer 安全点；生产实现开始。

## 会话：2026-08-08（P5 本地发布与故障验收闭环）

### 启动

- **状态：** in_progress
- 用户要求继续上一批给出的后续工作，并沿用测试、GitHub 提交/合并与分支清理流程。
- 已刷新 `main=origin/main=41ab8c2`：Foundation 与 PostgreSQL Integration 双绿、无开放 PR、工作区干净；Gitea 不操作。
- 已创建 `codex/p5-local-release-hardening`；本机仅有 Apple Development 身份，CUPS 0 队列，因此正式公证与实体出纸继续作为外部门禁。
- 三路只读盘点已冻结本批 1–5：依赖 high 清零、Runtime universal/release、upgrade/rollback、整日故障演练、软件打印闭环。
- 阶段 2 发布接线已启动：仅负责 Runtime universal/inspect、正式 release orchestrator、
  签名 manifest 生成与 Counter bundle 内 update config；Swift upgrade/rollback 由主任务负责。
- 阶段 2 发布接线已完成：Runtime 在本机真实编译为 `x86_64 arm64` universal 并通过
  `codesign --verify --strict`；正式 orchestrator 使用固定无 shell argv、白名单环境、指定
  Keychain/notary profile 与外部公钥，缺凭据/坏公钥在外部命令前失败关闭。
- Runtime manifest 生成器与原生 schema 同构，ephemeral Ed25519 测试覆盖精确字段、公私钥
  匹配、权限、rollback 与 create-only；Counter 正式 release 改为 universal DMG/ZIP，运行时
  只读 bundle 内严格 URL/channel，开发包使用独立 disabled 配置。
- ADR-30 已冻结 Runtime 发布、升级与受控回滚：候选必须签名并精确绑定当前唯一回滚目标，
  升级前创建一致性安全点，失败自动恢复；一步回滚经 stdin 摘要确认并保留回滚前安全点。
- Runtime Swift 已实现 CLI/GUI upgrade/rollback、私有 transition/release history、历史最高版本
  防降级和 normal-operation fail-closed；Swift lint/build 通过，无仓库验收扩为 39 场景、
  manifest 负例 8 项并全绿。
- 依赖线已把 audit 从 14 high 收敛为 high/critical=0；Electron 41.10.3、Electron-Vite 4、
  Vite 7、Router/PostCSS 与安全传递补丁已完成，两个不可达 moderate 进入精确例外门禁。
- 当前并行收口有流水日结冻结、维护/支持包故障演练与真实 PG→fake CUPS→签名回执软件链。
- 阶段 4–5 已实现并实测：真实 PostgreSQL Server 全量 792/792、0 skipped；浏览器
  17/17；真实 HTTP/PG 签名打印到 fake CUPS、超时 uncertain/重启不重打、在线备份、
  restore drill 与运行中/停机支持包均通过。
- 首次完整验收发现默认 7 个 Playwright workers 与生产同账号并发预约阈值 5 冲突，已固定
  4 workers；登录提交时立即从 DOM 清密码，429 负测确保失败工件不保留真实凭据。
- packaged macOS 首轮进入 R3 充值确认框但旧 E2E 没点击二跳，已同步为先断言服务端冻结
  ¥50.00 摘要再确认。当前等待 release 安全复审的 signer-only 环境、原子 staging 与递归
  Mach-O/安装包等价整改，随后重跑最终 local acceptance。

## 会话：2026-08-08（P4 Owner 运营与本地恢复闭环）

### 启动

- **状态：** in_progress
- 用户要求继续完成上一批给出的 1–5，并沿用测试后提交、推送、合入 `main`、删除临时分支的交付方式。
- 已刷新 GitHub：`main=origin/main=bc8cade`，工作区干净；Gitea 不操作。
- 已加载持久计划工作流并重建本批计划；先读取活动 ADR/Claude 基线，再并行盘点
  step-up、Owner 查询、LAN 接入、恢复 UI 与 packaged macOS 接线。
- 外部 KB `status.md` 停在 2026-08-02 / PR #133，仅作历史上下文，不作为当前真源。

### 阶段 1–5 实现与定向验证

- **状态：** implemented
- Stage 1 的 PG step-up proof 读取已显式绑定 org/store/proof，并覆盖跨租户及空 GUC。
- ADR-27 新增三类 Owner 明细与 active-admin 门店组合，契约冻结增至 25 查询；所有输入
  不接受客户端租户/日期/行数，输出无 PII、订单 UUID 或门店 UUID。
- Owner Web 已接三卡下钻与授权门店对比；权限/解析/刷新失败立即清旧数据，移动端操作
  目标不小于 44px；LAN 网关只新增两条固定只读查询。
- ADR-28 已交付证书完整性检查、无凭据 QR/设备指引和有界 LAN 诊断；默认网卡明确选择
  `en0/192.168.1.2`，不使用 Clash TUN 地址。
- ADR-29 已在原生 Runtime.app 接通托管 create/list/verify/restore、stdin 确认、预恢复
  安全点与维护锁；无 HTTP/Electron/AI 恢复面。
- Web 全量 324/324；真实 PG 串行门禁迁移 1/1、step-up 5/5、Owner 2/2；Runtime 真实
  容器数据库/照片恢复验收通过，所有隔离容器、卷和端口均已清理。
- 当前等待最终 LAN E2E、workspace 总门禁和 TypeScript 终审后进入 GitHub 交付。

## 会话：2026-08-07（P3 局域网 Owner Dashboard）

### 启动

- **状态：** in_progress
- 用户批准按既定 1–5 开多 Agent 实现，完成测试后提交推送；并明确可使用本地 Web Server
  做真实验证。
- GitHub 基线为 `736dd13`，本地 `main` 与 `origin/main` 一致、工作区干净；Gitea 不操作。
- 已读取持久计划与提交规范，当前先并行定位充值确认、Owner Dashboard 投影、Web 接线与
  LAN 安全边界，再按依赖顺序集成。
- 当前活动路线只交付 Linux 本地 Server/Web；macOS、云部署、Windows、AI 与自动通知后置。
- 已从最新 `main=736dd13` 创建 `codex/p3-owner-dashboard`；三个 Agent 分别负责充值确认
  实现、Dashboard 后端定位、Web/LAN 安全定位，主 Agent 负责集成与持久计划。
- 后端架构定位已完成并转入并行实现：仅新增
  `reporting.owner_dashboard.get`，strict 空输入、固定 30 日趋势、R1 +
  `accounting_read`，不新增 owner/manager 角色、不进入 AI 投影。
- ADR-26 已以 Accepted 落档，冻结四指标真值、单店会话范围与局域网 HTTPS 网关边界。

## 会话：2026-08-01（M2 本地产品化）

### 启动

- **状态：** in_progress
- 用户批准按上一批 1–5 依次实现，完成测试后提交推送并给出下一批。
- 已读取持久计划、Playwright 与提交规范；`npx` 可用。
- 已刷新 GitHub：`HEAD=origin/main=81b2d44`，无开放 PR，Foundation 与
  PostgreSQL Integration 主线运行均成功。
- 已确认工作区干净，创建 `codex/m2-local-productization`；Gitea 不操作。
- 当前进入阶段 1：同步最新 SPA、补会员 packaged macOS E2E 与状态真源。

### 阶段 1–5 实现完成

- **状态：** implemented
- 当前 Web SPA 已以内容寻址 bundle 同步到 Edge，并由只读 drift gate 防止打包旧 UI。
- 普通 offline grant 已使用独立持久序号、Edge 加密队列与 PostgreSQL 事务内验签、
  防重放、当前权限/吊销复核；Primary lease 仍保持独立权威。
- 真实订单打印已形成 PostgreSQL 签名快照 → 一次性 capability → Edge 验签/ESC/POS →
  CUPS → 设备签名回执 → PostgreSQL 原子结算闭环，含 uncertain 与精确幂等恢复。
- 独立原生 Runtime.app 已覆盖安装、启停、诊断、launchd、中断恢复与 no-repo 验收；
  Server/PG 容器以固定非 root 用户、只读根文件系统、零 capability 运行。
- XP-58 人工验收入口、A/B 恢复演练和正式发行失败关闭入口已完成；本机无 CUPS 队列且
  只有 Apple Development 身份，因此实体出纸、Developer ID、公证和 Gatekeeper 未宣称通过。
- 独立 TypeScript、数据库与安全复审问题全部收口：打印隐私、grant 高水位、撤销后精确
  回执幂等、SQL 参数/事务回滚、CUPS close 语义、executor 错误可见性、运行时非 root、
  打印订单索引均已修复并补回归。
- 完整本地验收已新鲜通过：Browser 12/12、packaged macOS 1/1、
  `LOCAL_ACCEPTANCE_OK`；packaged 链覆盖会员余额、普通 offline grant 与恢复后同卷重启。
- 验收额外发现并修复两处产品接线：默认运行时漏接会员命令/查询与顾客权限；真实 PG
  对账服务端遗漏 `balance` 付款桶。相关定向回归分别 7/7 与 8/8。
- 当前进入阶段 6：在上述最后修复后重跑全仓与全量真实 PostgreSQL，再提交 GitHub PR。

### 阶段 6：最终本地复验

- **状态：** verified
- 最后修复与 CHANGELOG 同步后，`pnpm workspace:check` 新鲜通过：format、lint、
  typecheck、test、build、文件规模和 SPA 漂移全部全绿；基础门禁 127/127，Edge
  358/358，Server 非 PG 环境 636 passed / 32 个明确 opt-in skipped。
- 隔离 project `laundry-pg-full-final5` 在新卷连续执行两次生命周期：34 个迁移首次应用，
  第二次全部识别为已应用；bootstrap 从 created 收敛为 unchanged。
- 全量 Server 在真实 PostgreSQL 下 668/668、0 failed、0 skipped；测试容器、网络和唯一
  命名数据卷已清理，8543/8787 无监听。
- 首次测试 harness 使用 macOS `$TMPDIR`，因 `/var` 符号链接祖先被配置安全边界按设计
  拒绝；改用规范化 `/private/tmp` 后通过，未放宽生产规则。
- 当前进入 GitHub 基线刷新、安全变基、最终差异复核与 PR/CI。

### 阶段 6：GitHub 交付

- **状态：** delivered
- 提交 `12ca475` 已推送 `codex/m2-local-productization`；PR #132 的
  `workspace-check`、`runtime-app-macos`、`real-postgres` 分别 4m50s、1m11s、8m46s
  全绿后 squash 合入。
- GitHub `main=9e3e7fa`；主线 push 的 Foundation 全绿（workspace 4m30s、Runtime
  51s），PostgreSQL Integration 8m12s 全绿，含双次迁移/bootstrap、RLS/HTTP、恢复演练、
  Server 零跳过与真实 Chromium E2E。
- 本地已快进到 `main=9e3e7fa`；远程与本地 `codex/m2-local-productization` 均已删除，
  工作区干净。
- Gitea 全程未 fetch、未 push、未修改。

## 会话：2026-07-30（M1.6）

### 启动

- **状态：** in_progress
- 已更正 M1.5 账本：PR #123 已 squash 合入 `main=f673ece`，临时分支已删除。
- 已刷新 GitHub：`HEAD=origin/main=f673ece`，无开放 PR，Foundation 与
  PostgreSQL Integration 主线运行均成功。
- 已确认工作区干净；Gitea 未 fetch、未 push、未修改。
- 已重读 ADR-14、产品设计、Claude draft3.1a 架构/UI、ADR-13；外部 KB
  `status.md` 停在 Grok/PR #99，明确不作为当前真源。
- 已将用户批准的下一批五项写入 M1.6 持久计划，当前进入架构盘点。
- 阶段 1 已完成：设备一次性 challenge、持久设备/grant/lease/epoch/seq、专用
  `edge_replay`、原员工与代传员工双审计、Edge signer pin 和跨批次混搭拒绝均已接通。
- 单元、lint、typecheck 全绿；隔离真实 PostgreSQL 首轮发现并修复 POSIX 正则
  `{40,256}` 超出 PG 重复上限，复跑 RLS smoke 与 authority/replay 2/2、零跳过。
- 当前严格进入阶段 2：加密离线只读缓存与断网冷启动。
- 阶段 2 已完成：缓存只接受服务端 Ed25519 签名的 12 小时 OfflineGrant，
  使用 Keychain 包裹独立 AES-256-GCM 数据密钥，按精确查询键原子持久化。
- 断网冷启动仅恢复无令牌只读会话；显式撤权、服务恢复、过期、篡改、时钟回拨、
  密钥丢失和会话上下文变化均失败关闭，Primary 写租约仍为 60 秒。
- 新鲜复验：Contracts 713/713、Edge 272/272、Web 224/224；相关 lint、
  typecheck、Prettier 与 `git diff --check` 均通过。
- 当前严格进入阶段 3：统一对账、账本、打印和离线冲突中心。
- 阶段 3 已完成：服务端冻结交班、账本、打印、回放与冲突对账快照和安全 CSV；
  Web/macOS 共用账目界面校验导出摘要，并保留 R3/R4、权限、幂等和审计边界。
- 独立复审发现并修复两个 P1：交班排除 draft/cancelled；退款双人批准把发起人和
  实际批准人写入同一事务审计，且不持久化 PIN/proof/session。
- 真实 PostgreSQL 固定时钟揭示同秒退款会被随机 UUID 排到原付款之前；新增
  `ledger_seq` 持久顺序和引用拓扑失败关闭，避免用测试时间偏移掩盖生产问题。
- 新鲜验证：DB 54/54；Server 对账/交班/账本定向 41 项通过；隔离 PostgreSQL
  连续应用 31 个迁移两次、RLS smoke 通过，工作日与对账 9/9、零跳过。
- 当前严格进入阶段 4：A/B 双版本更新中断恢复与安全回滚演练。
- 阶段 4 已完成：下载、提取、签名 Team、健康和激活失败均清理候选根并释放更新
  租约；成功候选保留，pending/inflight 队列在网络和文件系统前阻断。
- security-floor 禁止回滚时不再退出 App；当前安全壳以不可变只读/仅处理既有打印
  spool 的恢复模式启动，不确认坏槽、不继续自动更新、不签发或回放 Primary Lease。
- 生产同构演练使用真实 manifest 签验、流式大小/SHA-256、原子下载、状态机与控制器，
  覆盖 13 个篡改/中断/崩溃/确认/恢复场景；CLI 只输出
  `UPDATE_RECOVERY_DRILL_OK`，不冒充 Developer ID 或公证证据。
- 新鲜 Edge 全量：脚本 44/44、TypeScript 286/286，共 330 项、零跳过。
- 当前严格进入阶段 5：脱敏诊断支持包与 GitHub Actions 运行时维护。

## 会话：2026-07-30（M1.5）

### 启动

- **状态：** in_progress
- 已确认上一批 PR #122 合入，当前 `HEAD=origin/main=77b2f38`
- 已刷新 GitHub，最新 Foundation 与 PostgreSQL Integration 主线运行均成功
- 已确认工作区干净；Gitea 未 fetch、未 push、未修改
- 已将用户批准的五项能力写入 M1.5 持久计划，当前进入架构盘点与临时分支创建
- 物理 CUPS 打印机和 Apple 正式签名凭据继续作为独立外部门禁

## 会话：2026-07-30（M1.4）

### 启动

- **状态：** in_progress
- 已阅读 M1.3 任务计划、进度与发现，确认上一批已合入并删除临时分支
- 已刷新 GitHub：`HEAD=origin/main=68860ce`
- 已确认主线 Foundation 与 PostgreSQL Integration 双绿
- 已创建 `codex/m1-4-local-operations-hardening`
- Gitea 未 fetch、未 push、未修改
- 当前进入阶段 1：生产工作台、客户合并和交班历史完整 E2E

### 阶段 1：完整 E2E

- **状态：** completed
- 新增真实 PostgreSQL Browser 生产流、R4 客户合并和交班历史 CSV 验收
- packaged macOS App 新增客户 R4 合并与历史交班读取
- 首轮验收发现并修复统计页自动加载覆盖操作员新日期的竞态
- Browser 11/11、packaged macOS 1/1，`LOCAL_ACCEPTANCE_OK`
- 当前进入阶段 2：货架位、扫码上架、快速找衣和取衣复核

### 阶段 2：货架与取衣复核

- **状态：** completed
- 新增 `rack_zone/rack_slot` 权威位置、不可变上架日志和 `garment.rack.assign`
- 通用状态迁移不再允许无位置直接进入 `racked`；上架只接受门店内精确条码和 `ready`
- 取衣对所有选中上架件执行条码集合精确匹配，错误、漏扫、多扫均失败关闭
- Web/macOS 共用加工台支持扫码上架、货架快速搜索、取衣逐件复核与状态展示
- Contracts 708、DB 50、Server 518、Web 216 均通过
- 隔离真实 PostgreSQL 应用 27 个迁移；Browser 11/11、packaged macOS 1/1，
  `LOCAL_ACCEPTANCE_OK`
- 当前进入阶段 3：客户保留、导出、删除与隐私审计

### 阶段 3：客户隐私生命周期

- **状态：** completed
- 新增 `customer.privacy.status/events/export` 与 R5 `customer.anonymize`，导出最多
  1000 笔订单并标记截断，匿名化要求精确输入 `ANONYMIZE`
- 真实 PostgreSQL 用窄化 `SECURITY DEFINER` 权威覆盖组织内门店，活动订单存在时
  匿名化失败关闭；直接 PII 清除后保留不透明财务行和不可变隐私事件
- Web/macOS 共用隐私面板支持另一员工 PIN、JSON 下载、活动订单阻断和最近操作记录
- Contracts 709、DB 50、Server 520、Web 218 均通过
- 隔离真实 PostgreSQL 应用 28 个迁移；Browser 12/12、packaged macOS 1/1，
  `LOCAL_ACCEPTANCE_OK`
- 当前进入阶段 4：定时灾备、保留轮换、恢复演练和健康告警

### 阶段 4：自动化灾备

- **状态：** completed
- 新增每日 03:00 macOS LaunchAgent 安装入口，固定执行受管维护命令且不写入 secret
- 备份、轮换和恢复演练共享私有互斥锁；最近成功/失败写入原子状态文件
- 保留轮换默认 dry-run，显式 apply 才删除，始终保留最新恢复集且不自动删除损坏集
- 影子库演练完整校验数据库与照片，随机库名恢复、固定 schema 查询后删除影子库
- `local:diagnose` 新增 26 小时新鲜度、最近失败和演练时间健康状态
- 运维 60 个测试与 lint 全绿；隔离真实 Compose 备份→演练→诊断输出 `healthy`
- CI 新增每周 schedule，并在真实 PostgreSQL 门禁中执行恢复集与影子库演练
- 当前进入阶段 5：macOS 签名、公证、升级链路和实体打印验收

## 会话：2026-07-30（M1.3）

### 启动

- **状态：** in_progress
- 已阅读上一批计划、进度和发现，确认 M1.2 已合入并完成分支清理
- 已刷新 GitHub：`HEAD=origin/main=c47a1ec`
- 已确认主线 Foundation 与 PostgreSQL Integration 双绿
- 已创建 `codex/m1-3-fulfillment-operations`
- Gitea 未 fetch、未 push
- 阶段 1–4 已完成：件级履约、批量工作台与异常、客户治理、交班历史与安全 CSV
- 阶段 5 已完成一体化灾备、真实恢复演练和 macOS 打印安全试点
- 真实 PG 回归发现并修复客户合并缺少门店 GUC、待取订单无法取衣两个根因
- `pnpm workspace:check`：format/lint/typecheck/test/build 全绿
- 隔离真实 PG：26 个迁移、RLS、Server 530/530、Web E2E 8/8
- 真实灾备恢复：数据库和照片均从故意破坏状态恢复，输出 `LIVE_DISASTER_RECOVERY_OK`
- `pnpm local:acceptance`：Browser 8/8、packaged macOS 1/1、`LOCAL_ACCEPTANCE_OK`
- macOS CUPS 发现链路通过；本机无打印队列，因此未提交实体试打
- 当前开始提交前独立复审与 GitHub 交付收口
- 独立复审发现并修复灾备清单路径逃逸和 pre-restore 失败后服务不恢复
- 专项安全复核确认双层路径约束有效；相关回归 8/8
- 修复后再次执行 `pnpm workspace:check`，全量门禁继续全绿
- 复审结论：无置信度 ≥80 的残留问题，代码审核通过
- 提交 `3dd6dff` 已推送 GitHub，PR #121 双门禁成功
- PR #121 已 squash 合入 `main=68860ce`
- 合入后主线 Foundation 4m19s、PostgreSQL Integration 6m44s，均成功
- 本地与远程 `codex/m1-3-fulfillment-operations` 已删除
- Gitea 未 fetch、未 push、未修改
- **状态：** completed

### M1.3 测试结果

| 测试            | 输入                              | 实际结果                              | 状态               |
| --------------- | --------------------------------- | ------------------------------------- | ------------------ |
| workspace:check | 全工作区                          | format/lint/typecheck/test/build 全绿 | 通过               |
| 真实 PostgreSQL | 26 migrations + RLS + Server      | 530/530，0 skipped                    | 通过               |
| 浏览器 E2E      | 隔离 PostgreSQL                   | 8/8                                   | 通过               |
| 真实灾备恢复    | PostgreSQL + 私有照片             | 数据库与照片精确恢复                  | 通过               |
| macOS 验收      | packaged arm64 app + 服务断线恢复 | 1/1，`LOCAL_ACCEPTANCE_OK`            | 通过               |
| macOS 打印发现  | CUPS 只读发现                     | 命令成功，0 个队列                    | 软件通过，硬件待验 |

## 会话：2026-07-30（M1.2）

### 启动

- **状态：** in_progress
- 已阅读上一批任务计划、进度与发现，确认 M1.1 已完成并合入
- 已刷新 GitHub：`HEAD=origin/main=e87a85b`
- 已创建 `codex/m1-2-counter-operations`
- Gitea 仅核对远程配置，未 fetch、未 push
- 当前开始阶段 1：照片查看、缩略图、失败重试和对象 URL 生命周期

### 阶段 1：照片查看与缩略图

- **状态：** completed
- 服务端新增鉴权缩略图路由，完整解码后输出无元数据 WebP 预览
- 浏览器 PhotoPort 以私有 Bearer 读取受限二进制，不向组件暴露 API URL
- Electron 新增 `photo.read` 命名 IPC，主进程限定固定 UUID 照片路由与二进制上限
- UI 支持缩略图、原图查看、加载错误重试和对象 URL 清理
- 拆分桌面传输支持模块，`http-transport.ts` 从 861 行降至 736 行
- 验证：Server 500 pass；Web 206/206；Edge 216/216

### 阶段 2：照片删除与安全强化

- **状态：** completed
- 上传按 UUID 幂等，完整解码并重编码去元数据；同键不同内容拒绝
- 删除在元数据、审计事务提交后清理文件，孤儿清理只处理受管文件
- 浏览器和 Electron 均只开放固定、鉴权且有 8 MiB 上限的命名照片能力

### 阶段 3：打印 Worker 运营

- **状态：** completed
- Worker 随 HTTP 服务启动、在 PG 关闭前停止，状态可安全查询
- 失败重试/补打沿用租约权威，spool 按数量和总字节执行受管产物保留

### 阶段 4：客户详情

- **状态：** completed
- 客户详情汇总历史订单、欠款、照片数和打印状态，并可跳转真实订单抽屉
- 修复快速切换客户时旧异步结果覆盖新客户的竞态

### 阶段 5：本地运维与验收

- **状态：** completed
- 新增私有备份、校验恢复和只读诊断；真实备份恢复闭环输出 `LOCAL_OPS_REAL_OK`
- `pnpm workspace:check`：format/lint/typecheck/test/build 全绿
- `pnpm local:acceptance`：Browser 8/8、packaged macOS 1/1、`LOCAL_ACCEPTANCE_OK`
- 真实验收发现并修复统计页查询期间展示旧营业日汇总的竞态
- 代码复审修复客户切换竞态和浏览器照片响应无界缓冲；无遗留高置信问题
- PR #120 首轮真实 PG 揭示照片删除缺少表级权限，新增最小 0024 DELETE grant
- PR #120 双门禁绿后 squash 合入 `main=c47a1ec`，临时分支已删除
- `main` push CI：Foundation 3m59s、PostgreSQL Integration 6m53s，均成功

## 会话：2026-07-29

### 阶段 1：工作日 E2E 补强

- **状态：** completed
- 已从 GitHub 最新 `main`（`28fa8f9`）创建 `codex/m1-1-photo-workflow`
- 已确认 `main` 的 Foundation 与 PostgreSQL Integration 双绿
- 已确认浏览器 E2E 当前 6/6、真实 PG 502/502 且 0 skipped
- PIN 快速切换使用 Playwright 专用虚构员工，PG 员工目录按请求刷新
- 开单覆盖折扣、附加、加急、运费与尾款结清
- 交班使用 `1999-12-31` 隔离营业日，不冻结当天柜台
- 真实验收发现并修复交班 UI 漏传现金核对字段

### 阶段 2：关键路径真实 PG 回归

- **状态：** completed
- 订单真实 PG 回归新增四类调价、stats/cash 汇总、交班快照与 audit 精确断言
- 照片真实 PG 回归新增命令提交后的 metadata 回读
- 隔离 PG 聚焦测试 4/4，0 skipped

### 阶段 3：照片安全存储后端

- **状态：** completed
- 迁移 0023 增加内容摘要、约束与租户内存储 key 唯一性
- 私有文件存储执行服务端 UUID 命名、0700/0600、魔数、8 MiB、配额、SHA-256、原子安装与孤儿清理
- 照片上传/下载只走认证、CSRF、来源校验和专用限流的固定路由
- 通用 `photo.register` HTTP 命令入口已关闭

### 阶段 4：Web 与 macOS 照片工作流

- **状态：** completed
- 浏览器 `PhotoPort` 与 Electron 命名 IPC 均不向渲染进程开放通用传输控制
- 订单详情支持选择、上传并重新查询持久化照片数量
- 修复原生 `fetch` this 绑定问题，并以品牌敏感 mock 防回归
- Electron 打包白名单补齐 `request-builder.js`，成品 `.app` 可正常启动

### 阶段 5：验收与交付

- **状态：** completed
- `pnpm local:acceptance`：浏览器 8/8、打包 macOS 1/1、`LOCAL_ACCEPTANCE_OK`
- `pnpm workspace:check`：format / lint / typecheck / test / build 全绿
- 文件规模门禁：触顶测试已拆分，生产文件与测试文件均在现行预算内
- 安全复审高优先问题已收口：固定照片挂载点、所有权标记、严格成功契约、显式加载错误
- PR #119 的 `workspace-check` / `real-postgres` 双绿后已合入 GitHub `main`
- 本地与远程临时分支已删除；Gitea 未写入

## 测试结果

| 测试                 | 输入                               | 预期结果  | 实际结果                                    | 状态 |
| -------------------- | ---------------------------------- | --------- | ------------------------------------------- | ---- |
| Web 类型检查 + lint  | 阶段 1 代码                        | 全绿      | 全绿                                        | 通过 |
| Web 单测             | 阶段 1 代码                        | 全绿      | 198/198                                     | 通过 |
| local:acceptance     | 隔离 PG + Browser + packaged macOS | 全绿      | Browser 8/8、macOS 1/1、LOCAL_ACCEPTANCE_OK | 通过 |
| 关键真实 PG 聚焦回归 | order workday + photo metadata     | 0 skipped | 4/4、0 skipped                              | 通过 |
| workspace:check      | 全工作区                           | 全绿      | format/lint/typecheck/test/build 全绿       | 通过 |

## 错误日志

| 时间戳     | 错误                                  | 尝试次数 | 解决方案                                                        |
| ---------- | ------------------------------------- | -------- | --------------------------------------------------------------- |
| 2026-07-29 | 交班 E2E 未进入已交班状态             | 1        | 补 `counted_cash_cents` / `retained_float_cents` 输入与结果展示 |
| 2026-07-29 | 旧默认卷 0019 checksum 冲突           | 1        | 保留旧卷，改用独立 Compose project 与临时配置                   |
| 2026-07-29 | 交班 `payment_cents` 断言误含 repay   | 1        | 按契约区分订单累计已收与 `kind=pay` 流水                        |
| 2026-07-29 | macOS 打包应用在 Electron launch 超时 | 1        | 补 `request-builder.js` 打包白名单与断言                        |
| 2026-07-29 | 浏览器照片上传没有产生 HTTP 请求      | 1        | 解除浏览器原生 `fetch` 的错误 receiver 绑定                     |
| 2026-07-29 | 两个文件触发 max-lines                | 1        | 拆桌面桥接契约和照片传输测试，不提高预算                        |

## 会话：2026-07-30

### M1.5 阶段 1–5

- **状态：** implemented
- 员工权限管理已覆盖角色、启停、隐私管理员、乐观权限版本、会话撤销和同事务审计。
- CUPS Worker 已接入 Electron 启停，提交前持久化不确定状态以避免崩溃后重复打印；
  本机新鲜发现仍为 0 个队列，因此实体 XP-58 证据未伪造。
- 离线队列以随机 DEK 加密，KEK 由 Electron safeStorage/macOS Keychain 保护；队列、
  冲突和更新状态均使用私有目录、原子写入和严格 Schema。
- Primary Lease 离线取衣、独立收款和补缴使用单调序列，联网后以原始幂等键重放；
  业务冲突持久化并在设置页提供重试/放弃。
- 更新运行时只接受固定无凭据 HTTPS 清单，验证 Ed25519、包大小、SHA-256、Developer
  ID 团队与 Gatekeeper；离线队列非空时不执行，更新窗口冻结新 Lease。
- A/B 激活使用一次性 nonce 确认；候选进程未确认则回旧槽，回退目标低于安全下限时
  失败关闭而不盲目降级。
- 定向类型检查以及 Edge/Server 新增核心测试已通过，下一步运行全仓与真实验收。
- 独立复审修复离线业务错误误判、崩溃恢复 FIFO、租约 RTT、权限版本绑定、CUPS
  回执回收、SQL CAS 与持久化失败边界。
- `pnpm workspace:check`、29 个迁移、Browser 12/12、packaged macOS 1/1、
  `LOCAL_ACCEPTANCE_OK` 全部通过。
- PR #123 双门禁通过后 squash 合入 `main=f673ece`；主线 Foundation 4m13s、
  PostgreSQL Integration 7m32s 均成功；临时分支已删除，Gitea 未操作。
- **状态：** completed

### M1.4 阶段 1–4

- **状态：** completed
- 生产工作台、客户合并与交班历史已纳入真实 PostgreSQL Browser 和 packaged
  macOS E2E。
- 货架位、扫码上架、快速找衣和逐件取衣复核已完成契约、事务、审计、幂等与
  租户隔离。
- 客户导出、保留状态、隐私事件和受限匿名化已完成权限、PII 与同事务审计回归。
- 定时备份、互斥、保留轮换、恢复演练和健康诊断已完成，并通过隔离数据库真实
  恢复演练。

### M1.4 阶段 5：本地分发与验收

- **状态：** completed
- Ed25519 签名升级清单覆盖版本、渠道、安全下限、契约/数据库边界以及 DMG/ZIP
  摘要和回退目标；校验失败关闭。
- macOS Release 入口强制 Developer ID 签名、公证、hardened runtime、entitlements
  和产物验签；缺少 `CSC_NAME` 的实跑已按预期失败关闭。
- 实体打印验收入口记录 CUPS 作业号和负载摘要，只有四项人工检查全部显式确认才
  写入私有验收记录；本机当前发现 0 个 CUPS 队列，因此实体出纸门禁尚未通过。
- 为恢复活动 V2 默认 400 行政策，已拆分客户隐私、订单查询和取衣 PostgreSQL
  职责，未提高文件预算。
- `pnpm workspace:check`：format、lint、typecheck、test、build 全绿；Server
  520 passed / 15 skipped（非 PostgreSQL 单元环境），其余数据库与 E2E 证据由
  `local:acceptance` 和 GitHub PostgreSQL Integration 独立提供。
- `pnpm local:acceptance`：28 个迁移、Browser 12/12、packaged macOS 1/1，
  `LOCAL_ACCEPTANCE_OK`；隔离容器、网络和数据卷已清理。
- 独立 TypeScript/安全复审的阻断项已全部关闭：取衣锁后条码复核与货架清空、
  恢复集保留保护、恢复演练清理顺序、Keychain 透传、升级版本窗、客户切换竞态、
  隐私管理员权限和稳定 `orders.customer_id`。
- 最终 `workspace:check` 再次全绿；文件规模门禁触发后将运行时角色解析与平台
  支持职责拆入小模块，没有提高冻结预算。
- 最终验收首轮 11/12 暴露第二店长标签已包含角色后缀，修正 E2E 选择器后完整
  重跑通过 12/12，而非单独重跑失败用例。

# 2026-08-08 P5 Runtime 发布安全收口

- Runtime upgrade/rollback transition v2 同时绑定切换前后 state、history、当前/前一签名
  manifest 和安全点；命令在 strict load 前恢复中断事务。
- fault injection 覆盖 upgrade 7 个、rollback 6 个原子写边界；universal/no-repo 验收
  `scenarios=52 manifest_negatives=8` 通过。
- Runtime 发布以 App 全树、ZIP、DMG SHA-256 seal 绑定已验证 bytes，发布前再次复核，并
  固定 bundle id、short/build version 与 TeamIdentifier。
- manifest 输入与 release 公钥通过 no-follow fd 在读前后复核 `0600`、单硬链、类型、大小、
  device/inode/mode/mtime；最终 rename 后清理失败明确返回 `committed=true`、
  `cleanup=pending`。
- Runtime JS/source/acceptance 定向 19/19，ESLint、Swift strict lint、Prettier、diff-check
  全绿；等待独立安全终审。

# 2026-08-08 P5 最终本地验收

- 依赖 high/critical 已清零，两个 moderate 例外由版本、路径与调用属性精确门禁锁定。
- Runtime universal、升级/回滚和发布安全终审完成；no-repo 62 场景、8 个签名清单负例。
- Counter 发布绑定 App 全树、ZIP/DMG、身份与签名输入，排他原子提交；统一安全终审无 P0–P2。
- 定位并修复多设备 Primary 竞争：管理员先拿普通 grant，再 best-effort 申请 Primary；打印验收
  不再无意义占租约。低风险命令可离线排队，Primary-only 命令继续失败关闭。
- `pnpm local:acceptance` 新鲜通过：浏览器 17/17、packaged macOS 1/1、真实 PG/HTTP 软件打印、
  维护备份、恢复演练、运行中/停机支持包、断网排队与恢复回放，最终输出
  `LOCAL_ACCEPTANCE_OK`；容器、网络、卷和临时目录均清理。
- packaged E2E 仅在临时启动参数使用 mock keychain；生产入口/成品业务代码不含该开关。
  Developer ID、公证、干净 Mac 真实 Keychain、正式更新源/OCI 与 XP-58 实体仍是外部门禁。
- 最后一次 `pnpm workspace:check` 新鲜通过：依赖审计 high/critical 为 0、格式检查、lint
  9/9、typecheck 12/12、测试 12/12、构建 9/9 全绿；基础/Runtime 187/187、Edge
  369/369、Server 738 pass / 54 个显式 real-PG 条件跳过 / 0 fail。完整 `local:acceptance`
  已在同一最终实现上补足真实 PostgreSQL、浏览器、packaged macOS、打印与恢复证据。
- P5 提交 `b55ff0d` 经 PR #140 squash 合入 GitHub `main=014b5f1`；本地/远程临时分支均删除，Gitea 未操作。
- PR 三门禁全绿；合并后 `main` 再次通过 V2 Foundation（workspace 5m29s、Runtime 1m12s）与
  V2 PostgreSQL Integration（9m03s，真实 Server 零跳过、真实 Playwright 通过、Compose 清理成功）。

# 2026-08-01 阶段 1 完成

- 修复 Web 会员充值 R3 `confirm_ref` 二跳；余额支付对账可解析并显示“会员余额”。
- macOS packaged E2E 已加入开户、充值、余额结账与对账链。
- Edge test 增加 Web build 后只读 SPA drift gate；最终 bundle 为 `887daec…`。
- 新鲜门禁：Web 257/257，Edge scripts 45 + dist 296，Web/Edge lint、typecheck、
  `SPA_CHECK_OK entries=3`、`git diff --check` 全绿。
- 最新 `.app` 构建与 packaged E2E 统一放在全部实现完成后跑，避免每阶段重复构建。

# 2026-08-01 阶段 2 完成

- Queue envelope v3 为普通 grant 增加持久 `per_grant_seq`；v2 Primary 保持自动重放，
  无序号的 v2 grant 只进入恢复/仲裁。
- Offline grant 与 Primary 权限严格分成 6/3，离线收件只允许欠账或现金；电子支付、退款、
  储值、权限和设置继续失败关闭。
- Edge 两阶段序号文件、加密队列和 server PostgreSQL 高水位组成连续链；业务写、回放记录、
  当前 RBAC/设备重校验和序号推进在同一事务内。
- Contracts 定向 61/61、Edge 定向 36/36、hash-app 10/10、DB 55/55、Server 完整
  617 passed / 27 opt-in PG skipped；隔离真实 PG 的迁移、grant replay 与 Primary replay
  3/3、0 skipped。
- 独立 TypeScript 复审未发现 blocking/high-risk；生产文件均未越 400 行默认线。
- 同批修复会员余额账本 planner 仍按柜台付款方式拒绝 `balance` 的运行时缺口；Domain
  153/153 与 typecheck 通过，外部 `payment.collect` 边界仍不开放余额。

# 2026-08-08 P4 Owner 运营与本地恢复闭环

## 阶段 0：基线与边界

- **状态：** completed
- GitHub `main=origin/main=bc8cade`，从干净基线创建 `codex/p4-owner-operations`；Gitea 未操作。
- 读完 ADR-13/14/16/21/26 与 Claude draft3.1a 产品/架构/UI 基线。
- 新增 ADR-27/28/29，分别冻结 Owner 明细/组合视图、LAN 接入诊断、Runtime.app 托管恢复。
- 三路并行实现 Owner 后端、LAN 接入与 Runtime.app；主线负责 Owner Web、共享接线和门禁。

## 阶段 1：租户查询纵深防御

- **状态：** completed
- `PgStepUpProofStore.get` 已显式按 `org_id + store_id + proof_id` 查询，RLS 外再加业务谓词。
- 单测覆盖 SQL 参数；真实 PostgreSQL 覆盖跨组织、跨门店、unset/empty GUC。
- 新鲜验证：TypeScript、ESLint、Prettier、diff check 全绿；真实 PG 5/5，0 skip，临时栈已清理。

## 阶段 2–3：Owner 明细与授权门店组合

- **状态：** completed
- 冻结两条只读查询，三类明细最多 50 行且不返回 PII/内部 ID；组合视图逐店重新证明 active admin，并限制 200 个候选、50 个结果。
- Web 已覆盖严格信封、乱序响应、权限撤销清屏、空态/错误态和 44px 移动端触控目标。
- 最新真实 PostgreSQL 覆盖营业日切界、精确 30×24h、跨组织/跨门店、无角色、inactive role/staff、51 店截断与 GUC 恢复，2/2 通过。

## 阶段 4：LAN 接入与诊断

- **状态：** completed
- 新增证书/SAN/密钥匹配检查、无凭据二维码和有界诊断；网关仍只开放固定 Owner 只读路由。
- 本机绕开 Clash TUN 使用 `en0` 地址完成真实 HTTPS 诊断与 Playwright 3/3；8787/8543 未暴露，临时进程、容器、卷和配置已清理。

## 阶段 5：Runtime.app 托管备份与恢复

- **状态：** completed
- 原生 create/list/verify/restore、严格 manifest、stdin-only 确认、预恢复安全点和故障停服已落地。
- Swift lint/build、30 场景 no-repo 验收和真实 PostgreSQL/照片容器恢复均通过，损坏输入负测失败关闭。

## 阶段 6：最终门禁与复审

- **状态：** completed
- `pnpm workspace:check` 完整通过：format、lint 9/9、typecheck 12/12、test 12/12、build 9/9；Server 792 项为 738 pass / 54 opt-in skip / 0 fail。
- Edge Agent 已同步最新 Web SPA，`SPA_SYNC_OK entries=3`；提交前秘密模式扫描与 `git diff --check` 均无发现。
- TypeScript/JavaScript、数据库和安全三路独立终审全部 Approve，当前 diff 未发现 P0–P3。
- 本地提交 `4990efe` 已推送为 PR #139，并 squash 合入 GitHub `main=41ab8c2`；本地和远程临时分支均已删除，Gitea 未操作。
- PR 三门禁全绿；合并后 `main` 再次通过 V2 Foundation（workspace 5m47s、Runtime macOS 48s）与 V2 PostgreSQL Integration（9m05s，真实 Server 零跳过、真实 Playwright 通过）。

# 2026-08-10 阶段 2 XP-58 实体打印

- **状态：** blocked_external_hardware
- 阶段 1 已经 PR #154 合入 `main=7e72b57`；push 级 Foundation 与 PostgreSQL Integration 均绿。
- 新鲜现场盘点确认 CUPS scheduler 运行但无队列/默认目的地/设备 URI；系统打印机列表为空；USB Printer interface class 7 为 0；无 USB 串口桥或局域网 IPP/IPPS/printer 服务。
- 未修改 CUPS、未提交打印任务、未生成实体通过记录。继续条件是接入并通电 XP-58，安装启用 accepting/idle 的真实队列。
- 软件候选已修复严格入队载荷、浏览器打印旁路、重复动作与操作员可见 job UUID，并把 macOS 验收升级为绑定 original/disconnect/reprint 三份已上传签名回执的 schema v3。
- Web focused 347/347、TypeScript、ESLint、Prettier 和 edge 验收 15/15 已由实现阶段通过；主任务仍需同步 SPA、运行 workspace 总门禁、独立终审、提交 PR 与主线 CI。

# 2026-08-09 ADR-36 云测试环境收口

- **状态：** in_progress
- 用户授权严格按登录、认证闭环、移植、门禁、重部署、重启 1→6 执行，最终提交推送
  `main` 并删除本次临时分支。
- 基线：`main=origin/main=661f4e2`，GitHub Foundation 与 PostgreSQL Integration 双绿，
  无开放 PR/Issue。
- hk-vps 指纹匹配；`laundry-desk.service`、Caddy、内外 health、TLS 与 SPA 当前正常，
  应用 loopback 登录仍为 401；服务器提示需要重启。
- 已创建 `codex/adr36-cloud-test`；Claude 工作树保持原样，待三项未提交变更安全移植并交付后清理。
- 阶段 1 完成：远端脚本在不输出管理员密码/token/cookie 值的前提下，以完整 UUID
  `device_id` 分别完成 loopback 和公网登录，均为 200、admin、设备绑定正确。旧 401 根因是
  手工请求缺少契约必填字段，不需要放宽认证或改变统一 401。
- 阶段 2 首轮 smoke 的刷新请求本身成功，但测试错误要求同一秒签发的 access JWT bytes 必须
  不同；生产测试只承诺 refresh/CSRF cookie 轮换。已收紧为验证 cookie 轮换和新 bearer 实际可用。
- 阶段 2 完成：公网 refresh/CSRF cookie 轮换、受保护员工目录、`customer.upsert` 写命令和
  客户查询回读均通过。数据库仅监听 127.0.0.1/::1；当前 staff=1、customer=1（唯一 ADR-36
  合成记录）、orders=0，无真实顾客 PII。
- 阶段 3 完成：在 `codex/adr36-cloud-test` 从最新 main 精确移植 Claude 的 config、13 项
  config test 与 ADR-36；三文件逐字 diff 相同，未带入其 3 ahead / 2 behind 的分叉历史。
- `workspace:check` 首轮在两条治理断言停止：README 路线仍冻结为本地 Web+macOS，且
  CHANGELOG 新路线段漏掉 ADR-13 的可点击链接。已按 ADR-36 同批更新测试与链接，未放宽
  v2-only 或 Windows 手动门禁。
- 阶段 4 完成：最终 `pnpm workspace:check` 全绿；隔离真实 PostgreSQL 完成 45 份迁移、
  重复 bootstrap、RLS 与 Server 823/823，临时容器/卷均清理。
- 阶段 5 完成：候选 `04a66e9f9b8badb34170bf4db7ffe0cfe93b7edd` 已从精确 Git archive
  构建并切换到 hk-vps；迁移 45/45、loopback/public health、TLS、SPA、登录、refresh、
  员工查询、客户写入/读回均通过，`kb.manpengan.xyz` 未中断。
- 部署期间发现迁移脚本失败路径的 EXIT trap 引用已离开作用域的局部 pgpass 路径，导致一份
  0600 临时凭据文件残留；未读取内容即精确删除并确认零残留。migrate/smoke 两脚本均改为
  subshell 可见的显式 owner 变量，并新增失败清理回归。
- 阶段 6 完成：维护重启后内核为 `6.8.0-137-generic`、`reboot_required=no`、失败 unit=0；
  SSH 指纹不变，desk、kb、Caddy、PostgreSQL、systemd 与完整认证链再次通过。
- 交付完成：PR #143 以 merge commit `a734a5dbdeb73e3e6659a9d71ef2876609bca0d9`
  合入 `main`；PR 与合并后主线的 workspace、Runtime macOS、真实 PostgreSQL/Playwright
  均全绿。`codex/adr36-cloud-test` 的本地/远端分支以及 Claude cloud worktree/分支已删除，
  无关 `feat/member-ui` 保持原样。

# 2026-08-10 晚间 Stage 1 真实部署收口

- 21:51 补齐白天交付账本：PR #156（`46bfc47`，云端发布与验收基线）、#157
  （`f1d7104`，readiness/远端错误码）、#158（`629bc9c`，staging symlink 误报）、#159
  （`a004481`，staging 权限）、#160（`1a588e7`，私有备份恢复读取）均已合入 `main`；
  晚间首次真实 prepare 使用最终 `1a588e7`。
- 21:37 第 1 项完成：未读取内容，精确删除本机 33-byte/0600
  `laundry-hk-release-token-c0cl77/release-token` 及其目录，`/var` 与 `/private/var`
  两种路径均复核为不存在；hk-vps `/tmp`、`/var/tmp` 无对应 token/临时 secret 残留，
  远端受管 acceptance secret 根只有预期 9 个 root:root/0600 文件与 0600 env 文件，
  无 `.tmp-*` 或额外条目。
- 21:40 第 2 项完成：20:59 `finalize` 已真实执行到首个 `api-evidence` 子步骤并以
  `CLOUD_RELEASE_REMOTE_API_EVIDENCE_FAILED` 失败，不是审批/会话中断；prepare 的远端
  secret materialize 已完成，API 失败发生在下载 8 个浏览器字段之前，Playwright/browser
  子集未启动。后续隔离证据为 `reminder_history` fixture SQL 拒绝连接并使 cleanup 失败。
- 21:40 第 3 项完成：本机 token 残留来自临时外层执行包装在非零退出时主动保留文件，
  不是仓库发布代码清理路径，也不是进程被杀；本轮不改仓库代码，后续重试改为 token
  仅在内存中传递、绝不落本机临时文件。
- 21:43 第 4 项完成（先验未通过旧状态）：read-only status 实际为
  `phase=awaiting_external_verification`、candidate/marker=`1a588e791d269cc1153b243776b56f137b130b45`、
  migration head=`0046_print_job_request_idempotency.sql`（46 条）；release flock 可无阻塞取得，
  无持锁者。prepare 已切换并迁移，finalize 的 API evidence 失败不会自动回滚，因此不是
  `stable/ae9808c/0045`。
- 21:49 第 5 项定点修复 checkpoint：当前 transition 已用内存 token 回滚，status=`stable`、
  marker=`ae9808c`；数据库按 expand-only 设计保留 migration 0046。真实根因为
  `inet_server_addr()::text` 返回 `127.0.0.1/32`，已仅改为
  `host(inet_server_addr())` 且允许集合仍为 `127.0.0.1`/`::1`；定向 9/9、lint/format/diff
  通过，提交 `78dda90` 已推送 PR #161，等待 required CI 后重跑 prepare/finalize。
- 22:01 PR #161 三项 required CI 全绿（runtime 3m30s、workspace 7m13s、real PG
  12m54s），已合入并快进到 `main=origin/main=9cc31c4`；开始以 token 仅驻内存的单进程
  包装执行真实 prepare→finalize。
# 2026-08-12 PR #173 合入后首次 0053 发布

- PR #173 已合入 `main@02b3883b9b5de1ea119bdcbe2f1ddde8cd9a0d4b`；本地 `main`、
  `origin/main` 与工作树一致。
- 精确 push SHA 的 V2 Foundation run `31604206437` 全绿：`workspace-check` 与
  `runtime-app-macos` 均成功；V2 PostgreSQL Integration run `31604206432` 的真实 Server、
  真实 PostgreSQL 与 Playwright 均成功。
- hk-vps 发布前指纹、专用 root key、主机资源、失败 unit 与 release status 均通过，起始状态
  为 `stable`；冻结参数为 expected `f276bdbf328ae20aba20c7985c690a63484afdca`、candidate
  `02b3883b9b5de1ea119bdcbe2f1ddde8cd9a0d4b`、migration `0053_factory_handoff_and_qc.sql`。
- 首次受控 `prepare` 在远端部署步骤返回 `CLOUD_RELEASE_REMOTE_DEPLOY_FAILED`，未取得 token、
  未进入本地 finalize；随后只读 status 已确认自动恢复 `phase=stable`，主机 failed units=0。
- 按失败即停线，Stage 4.4 第 1 项尚未开始；当前只允许只读取证与针对首因的修复/验证。
- 只读取证进一步确认：候选没有 rolled-back history、transition、staging、failed tree、incoming
  archive 或 controller；线上 marker 仍为 `f276bdb…fdca`，数据库仍为 48 条迁移、head 0048。
- `laundry-desk`、PostgreSQL、Caddy、KB 服务均 active，desk loopback/public health 均 200；
  远端现有 release preflight、acceptance destination 及 9 项 source→private secret 等值检查通过。
- 下载 6.9MB 非秘密 retained-controller 树到本机 0700 临时目录，以候选 validator 验证 7/7
  通过后已清理；精确 Git archive 的无 `node_modules` remote entry import 与 controller 安装也
  在隔离临时目录通过并清理。
- sshd 记录表明实际 remote-deploy 会话于 22:15:35 接受公钥、22:15:38 由客户端正常断开，
  不是网络 reset；controller/acceptance 目录时间戳未变化，故失败边界在 transition 之前且在
  controller 安装/acceptance 写入之前，剩余范围是 bootstrap 的 archive 校验、staging 创建/
  解包或进入 remote main 前后的匿名失败。当前脚本把这类失败压成 generic code，证据不足以
  安全选择修复或重试，因此保持 fail-stop。

# 2026-08-13 十八项统一交付进展

- 用户已明确要求不按单项部署：18 项全部完成并统一集成测试后，才推送、合并与部署。
- Item 1 最新精确提交为 `622e6f8d0cdf2b2859d7deff0164d79e556350d3`，相对基线严格一个提交且工作树干净；fresh 0001→0054 PostgreSQL commissioning、catalog golden、Web/Server/Contracts/DB 定点门禁已绿；独立安全终审确认 P0/P1/P2=0 并 APPROVE exact SHA。
- Item 2 `f9011ab`、Item 3 `ca340bd` 已在原链上独立终审通过；因 Item 1 的 0054 安全修复改变迁移 bytes，最终集成必须重算 0055/0056 catalog golden，不能直接沿用旧 integration 分支。
- Item 4 由独立 worker 推进；Item 5/6 尚未开始。
- Item 8 精确 `d0ec301` 已独立终审通过；Item 9 精确 `cc30ca0` 已完成真实 PG、两轮独立安全终审并形成唯一提交；Item 10 精确 `8c5bc48` 已完成最终五项修复与 fresh PG，等待再次独立安全复审。
- Item 12 有候选 `f8099f2`；Item 13 仍受外部 OpenAI/provider 凭据授权边界约束；Item 14–18 尚未启动。
- 旧集成分支目前只含旧版 Item 1–3，不作为最终交付链；待 Item 1 终审通过后从 `main` 新建干净集成链。

## 2026-08-13 最新实现检查点

- 已形成严格单提交的 Items 为 `16/18`：1–12，以及 14、16–18；均未逐项部署。
- 最终集成分支 `codex/stage44-45-integration-v2` 已从 `main@27f0a7a` 顺序串入 Items 1–5，
  当前 HEAD `e054c7e`，工作树干净；Item 4 后的 fresh PostgreSQL 0054→0057 与 workspace 门禁已绿。
- Item 5 exact `3791cb7` 已完成 `/mobile/tasks`、读写 authority/offline/WYSIWYS 与 Web 门禁；
  Item 7 exact `1111f73`、Item 10 exact `ce253c2`、Item 12 exact `0a0ee50` 均已关闭已知阻断。
- Item 11 exact `c6eae55d4828a378f1859d2d78061047d9b20ca1` 已完成钱包/权益只读投影、
  portal-owned 地址与通知偏好 CAS，fresh PostgreSQL 0001→0062 共 57 迁移及真实行为 1/1 通过。
- Item 14 exact `b729cc3b1a3f1f40d78b3edc391f3feb4c51d67d` 已完成 provider-neutral SSE、
  durable events 与有界 tool loop；0065 真实 PostgreSQL、Contracts/DB/Server/Web focused 全绿，
  默认保持 AI hard-off 且没有真实 provider 网络请求。
- Item 6 exact `4cd26ebc873ec994b1a43f8c7dc5f0ee1561350a` 已完成 0058、照片/签名/GPS/
  异常证据、原子腿完成、私有媒体路由和移动 H5；独立 8558 真库 1/1、聚焦与五包门禁全绿，
  并已等价串入集成分支为 `466c119`。Item 16 exact `83d45f68620cbebf35971386e0b79f609f3d3a84`
  已完成 0068 异步审批中心、R3/R4/R5 边界及真库 1/1。Item 17/18 正并行收尾。
  执行节奏已按用户要求
  收敛为一次 focused/type/lint/build 与必要真库，不再重复启动同一差异的多轮 reviewer。
- Stage 4.4 集成分支已将 Items 7–11 的第二父链 `0b70d20` 与 Items 1–6 的 `466c119` 语义合并为
  `d57ed0924c3bf8673add232cf32bf290e3b6131b`；0054–0063、76 commands/61 queries、Owner/
  Customer/Mobile 三入口、OpenAPI 与 SPA 生成物已统一。新鲜 Contracts 19/19、Server runtime
  11/11、build/typecheck/lint、Web/DB focused 和 diff/规模门禁通过，集成 worktree clean。
- 同一最终集成分支已继续串入 Item 12 等价提交 `30d2ddd` 与 Item 14 等价提交 `47e9b57`，迁移头
  推进到 0065；Stage 4.4 顾客安全 OpenAPI 与 AI HTTP 投影的组合已通过 Contracts 8/8、DB 44/44、
  Server/Web typecheck，`build-document.ts` 通过 namespace 收敛保持 399 行。
- Item 18 exact `f93082188a1f0b42fa349a4778213139875eb173` 已完成 0066 整数 token/成本账本、
  预算 reservation、持久熔断、PII/Prompt Injection/SSRF 防线和降级审计，并撤销 0065 旧函数的
  绕过执行权；真 PG `AI_0066_REAL_PG_OK`。统一分支等价提交 `1d50d56` 后，Contracts 9/9、DB
  42/42、Server 10/10、Web 1/1 与 build/typecheck 均绿。用户明确暂不创建真实 OpenAI key，
  Item 13/15 后置；当前继续 Item 17 与不依赖 provider 的统一门禁。
- Item 16/17 已语义合入统一分支：`3c0f4e4` 保留 R4 异步审批中心，`1f84451` 加入 0069
  有界自动化；冻结面为 82 commands / 64 queries。Item 17 独立提交 `52c0552` 的 PG16 验收
  输出 `ITEM17_FINAL_PG_ACCEPTANCE_OK`，集成后的 Contracts/DB/Server/Web 聚焦门禁与四包 lint
  已绿。统一 `workspace:check` 首轮已通过 audit/format/lint/typecheck，测试阶段仅剩两个陈旧
  Foundation 断言（旧 migration head 与固定 PG 端口）待最小订正后定点重跑。
- hk-vps 仍保持已验证的 `f276bdb / 0048`，不会在 18 项全部完成和统一集成门禁前发布。
# 2026-08-13：恢复 Items 13/15

- 用户明确授权从 hk-vps Hermes 复用既有 DeepSeek API 凭据完成 Items 13/15；主机 ED25519
  指纹与 `hk-vps` key-only root 身份已重新核验，主机健康、failed units=0。
- Hermes 凭据源已在主机上确认（具体路径与变量名见运维私有记录，本文不落地），源文件
  `hermes:hermes 0600`；未在工具输出、对话或仓库中回显明文。凭据只复制到本机 `0700/0600`
  私有临时区供一次 DeepSeek 连接验收，完成后必须删除。
- Item 13 恢复真实 DeepSeek/OpenAI-compatible 验收；Anthropic/Gemini 在没有各自凭据时仅做
  官方协议夹具与失败关闭验证。Item 15 同步恢复，实现 0067 与只读经营/订单顾客/规程工具。

# 2026-08-15：Claude 接手，发布 `c04f858` 并收口

- Codex 会话已退出（最后动作：12:00:12 归档无主产物 `rollback-pre-ae9808c-20260809T112330Z`，
  紧接 PR #201 于 11:59 合入）。用户明确要求由 Claude 接手把剩余事项统一做完。
- 接手基线：`main = origin/main = c04f858362f1a02bf857b668513a1d1e29f64104`，工作树 0 变更、
  0 open PR，该 SHA 的 V2 Foundation 与 V2 PostgreSQL Integration 两套 push CI 均 success。
  hk-vps 仍是 `b80ab3e…9e1ec` / 0069，四个 unit active，Desk 与 KB 的 loopback/公网 health 全通，
  无活动 transition。未发布差量只有 PR #200 与 #201，无迁移变更。
- 发布前置逐条核对后纠正了一个错误判断：08-14 结果 §8 记的 `/opt` 产物上限并不是本轮阻塞
  （按 `laundry-desk.` 前缀过滤只有 5 个），真正失败关闭点是 **history = 8**，命中
  `assertRoomForRelease` 的 `count >= 8`。今天那次无主产物归档对 history 维度没有作用。
- 经用户明确授权，归档 `53b012c…ba64d6d3`（`outcome=rolled_back`、`phase=staged`、
  `authoritative=false`、`backup_path=null`、`evidence=null`、`write_gate_state=null`）及其绑定
  controller 到 `/var/lib/laundry-desk-release-archive/53b012c…-ba64d6d3-rolled-back-retention/`。
  先做身份证明再动手：首版守卫误用 `state` 字段（真实字段是 `outcome`）在 `mv` 之前失败关闭，
  无任何副作用；改正后同文件系统原子 rename，`history ino=1115533` / `controller ino=2032138`
  移动前后一致，`8/8 → 7/7`，剩余仍严格 1:1，未删除任何证据。
- 选择该条的依据是「退役后不产生 orphan」：另两条 `rolled_back` 各自绑定 backup dump，
  退役需连 backup 一并搬迁，面更大。
- 发布以单进程驱动脚本执行，correlation token 只留在进程内存与一个 0600 临时文件（供失败时
  rollback），日志里做了替换，不出现明文；成功后删除该文件。

## 2026-08-15 发布结果与收口

- **发布成功（第三次尝试）**：`CLOUD_RELEASE_COMMITTED candidate_sha=c04f858…4104`，
  status 回到 `stable`。transition 创建 09:13:56Z、提交 09:23:56Z；
  `compatibility_decision=same_migration`、`old_code_compatible=true`、
  `write_freeze_terminated_sessions=0`、`app_role_original_can_login=true`、
  `verification_evidence_authoritative=true`。
- 公网验收：API `ADR36-20260815T092315546Z-7450d875` **20/20 全 PASS**；
  Cloud Chromium `CLOUD-BROWSER-20260815T092340254Z-10d59011` `PASS`、`retries=0`。
- 发布后独立只读复核：marker `c04f858…4104`、无 transition、四 unit active、failed 0、
  迁移 69 条、`laundry_app rolcanlogin=t`、Desk loopback/公网与 `/health` 及 KB `/healthz`
  全 200、Desk 绑定 `127.0.0.1:8787`、PostgreSQL 仅 loopback、SPA 正常返回拆分后 chunk、
  回滚树 `laundry-desk.rollback-b80ab3e…-before-c04f858…` 已建立、`/` 可用 14 GiB。
- **两次失败均未损坏线上**：第一次 `CLOUD_RELEASE_PUBLIC_HEALTH_FAILED`（写门闩已释放后，
  自动回滚到 `b80ab3e` 并恢复 LOGIN 与健康）；第二次 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT`
  （预检即挡下，未进停写窗口）。诊断见 `findings.md` 与发布结果文档。
- 三次可恢复归档（全部同文件系统原子 rename，未删除任何证据，inode 逐项核对）：
  `53b012c…ba64d6d3` 两件套、`a832bbd…aa025081` 三件套、`c04f858…f3609fc8` 的 `/opt` failed 树。
- 回写：新增 `docs/operations/2026-08-15-artifact-archive-release-result.md`，订正运维手册的
  `/opt` 有效上限口径与工具鸡生蛋约束，订正 CHANGELOG 中「已在真实数据上验证」的表述，
  补 README 与交付计划链接。docs-only PR #202，prettier 与 foundation 53/53 通过。
- 本地残留清理：删除 `/private/tmp` 下 167 项 `laundry-*`（含 36 个 bootstrap 密码/PIN 文件、
  4 份存有 release token 的 `prepare.stdout`、12 个 commission/secret/signing 目录），
  移除 4 个遗留容器（`laundry-item9-pg` 及三个 spike）。命名卷保留未删。
- **下一次发布前的已知阻塞**：提交后四个留存集合重新到顶——history 8、controller 8、
  backup 8 对、`/opt` 常驻 6。按峰值口径下一次 `prepare` 会先以 artifact 上限失败关闭。
  但 #201 已上线，`--archive` / `--archive-orphan` 首次具备在真实 `/opt` 树上可用的条件，
  下次腾 `/opt` 槽位可以走工具；history/controller/backup 仍无工具，仍需手工搬迁。
