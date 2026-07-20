# M0-2 验收单 · Primary lease 时序 + 可信时间（Codex）

> 产出目录：`tools/spikes/m0-2-lease/`　证据落点：findings §M0-2
> 依据：架构 §10/§11、ADR-04

## 目标

证明 lease 的签发串行化与可信时间契约在全部对抗场景下 fail-closed——**任何时刻同店不存在两台可离线执行取衣/收款的终端**。

## 前置

PG（复用 M0-1 环境）；两个模拟 Edge 进程（Node 脚本即可）；可控假时钟（墙钟可拨、单调钟独立）。

## 步骤

1. 表：`primary_lease_heads(org_id, store_id, …, PRIMARY KEY(org_id, store_id))` 预建行 + `primary_leases(…, UNIQUE(org_id, store_id, primary_epoch))`。
2. 签发/release ACK/晋升同一事务：head 行 `SELECT … FOR UPDATE` → 重校验旧 lease → epoch++ → 插入 → 更新 head → 提交后返回**签名** lease `{lease_id, issued_at, ttl_ms, max_clock_skew_ms, not_after, sig}`。
3. Edge 模拟端实现 `local_deadline = request_start_mono + ttl_ms − safety_margin_ms`（锚点=发起请求前；判定**禁用 Date.now()**）。
4. 离线命令信封带 `lease_id + primary_epoch + per_lease_seq`，server 回放校验。
5. 跑通过标准全部场景（脚本化，可重复）。

## 通过标准

| # | 场景 | 预期（全部 fail-closed 向） |
|---|---|---|
| 1 | 双 owner 同时晋升（并发两事务） | 行锁串行，只产生一个新 lease；UNIQUE(epoch) 无违例 |
| 2 | 释放与晋升并发 | 同上，无双活 |
| 3 | 旧主墙钟**回拨** 2h 后继续离线取衣 | 本地单调钟照常到期失效；其越期命令回放被 epoch/seq 拒收进仲裁，**不自动应用领域状态**，回执仍写审计 |
| 4 | 旧主墙钟**前跳** | 不提前失效也不延长（判定不依赖墙钟） |
| 5 | Edge 进程重启 | 无法证明时间连续性 → lease 立即失效，高危操作降级 online-only |
| 6 | OS 重启 / 休眠跨期恢复 | 同上 |
| 7 | 旧主失联 + 新主申请：无 release ACK | 新 lease 必须等旧 `not_after` + `max_clock_skew_ms` 之后才生效；等待期新主仅在线操作 |
| 8 | 旧主在线签名 release ACK | 新 lease 即时生效，epoch 递增 |
| 9 | 长 RTT（人为延迟使 RTT ≥ TTL） | Edge 拒绝启用该 lease（local_deadline 恒 ≤ server not_after 不可满足） |
| 10 | 服务端响应延迟大但 RTT < TTL | local_deadline 仍 ≤ not_after（验证锚点取的是请求前） |

## 证据格式

场景矩阵表（场景|预期|实际|结论）+ 关键日志片段 + 时序图（文字版即可）+ README 复现步骤。

## 不通过的处理

同 M0-1：findings 标注 + @Claude；lease 语义需改 → 新增 ADR。
