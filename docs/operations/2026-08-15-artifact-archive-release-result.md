# hk-vps 归档工具修复发布结果（2026-08-15）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS**（第三次尝试提交；前两次均失败关闭且线上无损）
- 发布候选：`c04f858362f1a02bf857b668513a1d1e29f64104`
- 发布前 marker：`b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`
- 迁移头：`0069_bounded_automation.sql`（69 条，**发布前后一致**）
- 覆盖 PR：[#200](https://github.com/manpengan/laundry-desk/pull/200)、[#201](https://github.com/manpengan/laundry-desk/pull/201)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成本轮发布，不等于生产 SaaS、正式签名桌面
> 发行、XP-58 实体打印，也不等于真实短信/微信/AI provider 验收。

本轮把退役产物归档工具的两项修复送上线：#200 为退役账本从未认领的无主产物增加受控归档路径，
#201 修复 `measureTree` 拒绝符号链接导致该工具**从未能归档任何真实产物**（任何真实部署树都是
pnpm workspace，目标产物一棵树就有 2688 个 `node_modules` 符号链接）。

## 1. 精确发布身份

| 项                   | 证据                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `main` 合并点 / 候选 | `c04f858362f1a02bf857b668513a1d1e29f64104`（PR #201 合并点）       |
| 目标旧版本           | `b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`                         |
| 迁移身份             | `0069_bounded_automation.sql`（69 条），发布前后不变               |
| compatibility        | `compatibility_decision=same_migration`；`old_code_compatible=true` |
| transition 创建时间  | `2026-08-15T09:13:56.808Z`（台北时间 17:13:56）                    |
| 写门闩               | `write_gate_state=released`；`write_freeze_terminated_sessions=0`   |
| evidence 创建时间    | `2026-08-15T09:23:50.786Z`（台北时间 17:23:50）                    |
| committed 时间       | `2026-08-15T09:23:56.528Z`（台北时间 17:23:56）                    |
| verification_id      | `0d6d307a-48de-4003-a939-123492c66c8a`                             |
| 归档 / 控制器摘要    | `1bd24ab86176…` / `5fe258e8b83d…`                                  |
| 恢复点摘要           | `229105a61836…`                                                    |
| evidence 摘要        | `6d805ef6588d…`                                                    |

本轮没有 schema 变更，代码回滚被证明可行，回滚树保留为
`/opt/laundry-desk.rollback-b80ab3e1af8145f7c49b6767a87dcbf89079e1ec-before-c04f858362f1a02bf857b668513a1d1e29f64104`。

## 2. 候选门禁

精确 merge SHA `c04f858…4104` 的两套 `push` 工作流：

| 门禁                                                                                                         | 结果        |
| ------------------------------------------------------------------------------------------------------------ | ----------- |
| [V2 Foundation #31863250443](https://github.com/manpengan/laundry-desk/actions/runs/31863250443)             | **success** |
| [V2 PostgreSQL Integration #31863250533](https://github.com/manpengan/laundry-desk/actions/runs/31863250533) | **success** |

发布前只读核对：`HEAD` 与 `origin/main` 精确等于候选、工作树 0 变更（含 untracked）、当前分支
`main`、live marker 精确等于目标旧版本、库内账本 69 条与候选迁移清单一致、无活动 transition、
`phase=stable`、KB loopback/公网 `/healthz` 均 200。

## 3. 两次失败关闭与线上无损

**本轮最重要的运维事实是前两次尝试都失败了，且两次都没有损坏线上。**

### 3.1 第一次：`CLOUD_RELEASE_PUBLIC_HEALTH_FAILED`

失败发生在 `phase=switched`、写门闩已 `released` 之后，即已完成停写、备份、影子恢复与代码切换。
**候选代码没有问题**——journal 实证候选服务 13:03:17 启动、13:03:19 listening、13:03:20 自身
loopback `/health` 返回 200；此后到 13:03:35 被停止为止应用再没收到任何请求，间隔 14.3 秒，
公网请求根本没到达应用。

根因是 `assertDeskHealth`（`tools/cloud/hk-vps-release-remote-system.mjs`）里两个探针不对等：

- loopback 走 `awaitDeskReadiness(...)`，**有就绪重试策略**；
- 公网只有 `curl --fail --max-time 15 https://desk.manpengan.xyz/health`，**单发、零重试**。

14.3 秒正好撞 15 秒上限。本机在 NAT 后（私网 `10.0.217.104`），打自己公网域名要走 hairpin，
该路径出现一次十几秒停顿就会把整轮发布作废。已排除内存（可用 5.9 GiB、swap 0 使用、窗口内无
OOM 或 kernel warning）、UFW（22/80/443 全为 ALLOW、无 `limit` 规则、窗口内无相关 BLOCK）与
应用自身。事后从 VPS 连打 3 次公网 `/health` 均为 200 / 80–160 ms。

失败关闭后远端自动恢复：无 transition、marker 回到 `b80ab3e`、四个 unit active、
`laundry_app` LOGIN 已恢复、loopback ready、desk/kb 公网 200。

**建议后续单独提 PR**：给公网 health 探针加上与 loopback 同等的有界重试并补回归，使一次瞬时
抖动不再作废一整轮已完成停写、备份、影子恢复和迁移的发布窗口。

### 3.2 第二次：`CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT`

第二次在预检即被挡下，没有进入停写窗口。当时 `/opt` 的 `laundry-desk.` 前缀条目是 6，而
`assertRoomForRelease` 的字面判定是 `count >= MAX_RETAINED_RELEASES(8)`——只读代码会得出
「6 < 8 应当通过」的错误结论。

真实口径是本手册 §1.1 已记录的**预检峰值 = 常驻计数 + `incoming` + `next`**：`ARTIFACT_PATTERNS`
里确实存在 `laundry-desk.incoming-<sha>-<token>.tar` 与 `laundry-desk.next-<sha>`，发布过程中
`/opt` 会临时多出这两项，`6 + 2 = 8` 正好触顶。因此 **`/opt` 的有效上限是常驻 ≤ 5，不是 8**。
第一次尝试能越过是因为当时常驻为 5；它失败后留下的 `laundry-desk.failed-<sha>` 把常驻推到 6。

### 3.3 一次失败的真实代价

一次进入停写窗口的失败会同时消耗四个集合各一格：history +1、backup +1 对、`/opt` +1 树、
controller +1。连续失败会同时触及多个上限。且 #201 的归档修复在本轮之前尚未上线，线上运行的
仍是有 bug 的版本——**修复工具的前提是先发布，而发布又需要工具**，构成鸡生蛋，因此本轮三次腾
槽位全部只能手工守卫式搬迁。

## 4. 本轮的三次可恢复归档

全部为同文件系统原子 rename，**未删除任何证据**，反向 rename 即可完整还原；每次都先做身份证明
再动手，移动前后逐项核对 inode 证明是同一对象。

| 对象                                    | 内容                            | 结果                        |
| --------------------------------------- | ------------------------------- | --------------------------- |
| `53b012c…ba64d6d3`（08-13 首次 0053）   | history + controller            | history/controller `8 → 7`  |
| `a832bbd…aa025081`（08-12）             | history + controller + backup 对 | history/controller/backup `8 → 7` |
| `c04f858…f3609fc8`（本轮第一次失败）    | `/opt` failed 树                 | `/opt` 常驻 `6 → 5`         |

选择依据是**退役后不产生任何 orphan**，而不只是「最早」：第一次可选的三条 `rolled_back` 中只有
`53b012c…ba64d6d3` 满足 `backup_path=null`；到第二次时剩余三条全部绑定 backup dump，只搬 history
会留下 orphan backup，因此升级为三件套。

每次归档后都复核剩余 history ↔ controller ↔ backup 严格 1:1。首版守卫曾误用 `state` 字段
（真实字段是 `outcome`），守卫在 `mv` 之前失败关闭，未产生任何副作用。

## 5. 公网验收证据

| 层             | run-id                                       | 结果                                            |
| -------------- | -------------------------------------------- | ----------------------------------------------- |
| ADR-36 API     | `ADR36-20260815T092315546Z-7450d875`         | **20/20 全 PASS**，非 PASS 为 0                 |
| Cloud Chromium | `CLOUD-BROWSER-20260815T092340254Z-10d59011` | `test_status=PASS`、`test_count=1`、`retries=0` |

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。Browser 只证明公网读面
与零产品命令，完整写入与清理由同一 release identity 下的 API evidence 证明，两层不互相冒充。

committed history 的 `verification_evidence_authoritative=true`。

## 6. 发布后独立复核（2026-08-15 17:2x–17:3x，只读）

| 项          | 新鲜结果                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| transition  | `phase=stable`；无活动 transition                                           |
| live marker | `c04f858362f1a02bf857b668513a1d1e29f64104`；`environment=hk-vps-cloud-test` |
| 仓库一致性  | `main=origin/main=c04f858`，工作树 clean                                    |
| 数据库      | `laundry_schema_migrations` 69 条；`laundry_app` `rolcanlogin=t`            |
| systemd     | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0    |
| 监听        | Desk `127.0.0.1:8787`；PostgreSQL `127.0.0.1:5432` 与 `[::1]:5432`          |
| 健康        | Desk loopback 200；Desk 公网 `/` 与 `/health` 均 200；KB 公网 `/healthz` 200 |
| SPA         | 正常返回路由拆分后的 chunk（`index-*.js` + `react-runtime-*.js`）           |
| retention   | history 8；controller 8；backup 8 对；evidence 6；`/opt` 常驻 6             |
| 磁盘        | `/` 可用 14 GiB                                                             |

## 7. 下一次发布前的已知阻塞

提交本轮后四个集合重新到顶：**history 8、controller 8、backup 8 对、`/opt` 常驻 6**。按 §3.2 的
峰值口径，下一次 `prepare` 会先以 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT` 失败关闭，
history 与 backup 也各自触顶。腾槽位仍是一次单独授权的动作。

好消息是 #201 的修复已随本轮上线，`--archive` / `--archive-orphan` **第一次具备在真实 `/opt` 树上
可用的条件**，下一次腾 `/opt` 槽位可以走工具而不再手工搬迁；history / controller / backup 三类
证据目前仍没有对应工具，仍需手工守卫式搬迁。

## 8. 明确未取得

- 真实短信/微信与 AI provider 仍为 `software_only` / `blocked_external_provider`。
- 离机备份 authority、恢复介质与告警链仍是 `blocked_external_offsite`；同机 shadow drill 不能替代。
- 本环境只允许合成数据，不含真实顾客 PII，不等于生产 SaaS。
- Windows、macOS 正式签名/公证、XP-58 实体出纸继续按 ADR-37 后置。
