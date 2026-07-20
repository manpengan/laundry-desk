# M0-2 验收单：Primary lease 时序 + 可信时间

> 主责：**Codex**　验收：Claude　产出：`tools/spikes/m0-2-lease/`
> 依据：ADR-04 第 7 条（含终审 P0-1 与 diff 复核①②③）、架构 §7（lease 两表）/§10/§11、任务书 codex §2
> 公共规则见 [README](README.md)。

## 1. 目标

Primary lease 是防离线双花的地基，其安全性依赖三件事：**签发串行化、不重叠 lease、可信本地截止**。本 spike 用可注入时钟与并发脚本证明这三件事在实现层真的成立——纸面推理不算证据。

## 2. 步骤

1. PG 建两表：`primary_lease_heads(org_id, store_id, current_epoch, current_lease_id, current_not_after, version, PK(org_id, store_id))`（每店预创建一行）；`primary_leases(…, not_after, sig, UNIQUE(org_id, store_id, primary_epoch))`。
2. 签发/release ACK/晋升实现为**同一事务**：`SELECT … FOR UPDATE` head 行 → 重校验旧 lease → epoch++ → INSERT lease → UPDATE head → **提交后**才返回签名对象 `{lease_id, store_id, device_id, primary_epoch, issued_at, ttl_ms, max_clock_skew_ms, not_after, sig}`（`not_after = issued_at + ttl_ms` 入签名）。
3. Edge 模拟器：`local_deadline = request_start_mono + ttl_ms − safety_margin_ms`，**单调钟锚点取发起请求前时刻**（绝不用响应到达时刻）；墙钟仅作展示。时钟与 RTT 均可脚本注入（fake clock）。
4. 演练矩阵（自动化脚本逐场景断言）：
   - 六类时钟：回拨 / 前跳 / 进程重启 / OS 重启（单调钟基准丢失）/ 休眠跨期 / 旧主失联；
   - 并发：双 owner 同时晋升（两连接并发）；释放（release ACK）与晋升并发；
   - 长 RTT：RTT ≥ TTL；RTT 逼近 TTL（验证 `local_deadline ≤ not_after` 恒成立）。
5. 回放模拟：旧 epoch 离线命令（绑定 `lease_id + primary_epoch + per_lease_seq`）回放 → 断言回执写入审计、**拒绝自动应用领域状态**、打仲裁标记。

## 3. 通过标准（逐条判定）

- [ ] 双 owner 并发晋升：head 行锁排队，结果**恰一个**新有效 lease；任何唯一约束冲突都整体回滚、无脏数据。
- [ ] 释放与晋升并发：同一行锁下串行，不产生两个有效 lease。
- [ ] 有签名 release ACK：新 lease 即时生效，epoch 严格递增。
- [ ] 无 ACK：新 lease 生效时刻 **≥ 旧 `not_after` + `max_clock_skew_ms`**；等待期内新设备仅可在线操作（判定函数返回 online-only）。
- [ ] 时钟回拨的旧主：本地授权按单调钟到期，回拨**不能续命**；其过期命令回放被 epoch/seq 拒收 → 写审计 + 转仲裁，不自动应用。
- [ ] 六类时钟场景**全部 fail-closed**：时间连续性不可证 → lease 立即失效，取衣/收款降级 online-only。
- [ ] RTT ≥ TTL：Edge 拒绝启用（fail-closed）；全场景 `local_deadline ≤ server not_after` 无一例外。
- [ ] lease 有效性判定代码路径**无 `Date.now()`/墙钟**（静态 grep + code walk 双证）。

## 4. 证据格式

- `tools/spikes/m0-2-lease/README.md`：环境、脚本入口、一键复现。
- `evidence/`：逐场景 PASS/FAIL 汇总表（场景 / 预期 / 实际 / 判定）、关键时序日志（含各时间戳与时钟注入值）、签名 lease 对象样例 JSON、`Date.now()` 静态检查输出。
- DDL 独立 `.sql`——即 M1 A4（lease 签名对象进 contracts 桥协议）的实测底稿。
- findings `## M0-2` 小节按模板填写。

## 5. 不通过 / 需改设计

出现"两个同时有效 lease"或"回拨续命"任一例 = **一票否决**。等待期/容差语义与 spec 有出入 → 报「需改设计」，Claude 起草 ADR 澄清（不回改 ADR-04 正文）。
