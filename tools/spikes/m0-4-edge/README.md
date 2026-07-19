# M0-4 · Edge 本地通道 + 冷启动 + A/B 升级

**目标**（架构 §10 / §13.3 / §13.5、ADR-01、ADR-08）：

1. Windows 实测浏览器 ↔ `wss://127.0.0.1`：证书信任、Chrome LNA、防火墙 → **定通道形态**  
2. `app://` 加载**内置（签名占位）SPA**：断电/断网冷启动进本地工作台  
3. A/B 双槽 + 健康检查 + 本地库快照 + **按支持矩阵回滚判定**（禁盲目降级）

> 无 Windows 实机时：本目录即为可执行演练包；单测在 macOS/Linux 可先绿。现场按 `ops/WINDOWS-DRILL-RUNBOOK.md`。  
> Node **≥ 22.6**。LNA 的 L2 **禁止** loopback→loopback（见 `channel/LNA-CHECKLIST.md`）。  
> 回传录屏/截图 **去 EXIF**；仓库 PUBLIC。

## 目录

```text
channel/           WSS 服务、证书生成、浏览器探针、三类清单
cold-start/        最小 Electron app:// 壳 + 安全基线 + 清单
ab-upgrade/        A/B 状态机演练脚本 + 支持矩阵样例
ops/               Windows 总 runbook + 回传模板
test/              离线单测
```

## 快速开始

```bash
cd tools/spikes/m0-4-edge
npm install
npm test
npm run cert          # 需要本机 openssl
npm run wss           # https/wss://127.0.0.1:17443
# 另开终端：
npm run ab:init && npm run ab:install-fail && npm run ab:init && npm run ab:install-ok
node cold-start/print-runbook.mjs
```

明文对照实验（仅 lab）：

```bash
M0_4_WS=1 M0_4_PORT=17444 node channel/wss-server.mjs
```

## 验收标准

- 断网重启可进本地工作台（现场）  
- 通道方案有结论与数据（证书 vs 消息层加密 vs 壳内-only）  
- 回滚判定按支持矩阵：兼容才回槽；不兼容 → 恢复模式  
- 结论写入 `docs/research/2026-07-19-v2-m0-findings.md`

## 红线

- Edge **无业务校验**；本 spike 只验证通道/壳/升级状态机  
- Electron 安全基线硬性达标（见 cold-start 清单）  
- 私钥/生产证书不入库；`channel/certs/` gitignore  
