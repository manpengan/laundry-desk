# M0-4 · Edge 本地通道 + 冷启动 + A/B 升级

**目标**（架构 §10 / §13.3 / §13.5、ADR-01、ADR-08）：

1. Windows 实测浏览器 ↔ `wss://127.0.0.1`：证书信任、Chrome LNA、防火墙 → **定通道形态**  
2. `app://` 加载**内置（签名占位）SPA**：断电/断网冷启动进本地工作台  
3. A/B 双槽 + 健康检查 + 本地库快照 + **按支持矩阵回滚判定**（禁盲目降级）

> **现状（2026-07-20）**：开发侧 **无 Windows 测试机**。默认 `npm run lab:offline`（macOS/Linux）。  
> Windows 专属项（防火墙 UX、证书导入店员路径、断电冷启动）**挂起**，见 `ops/NO-WINDOWS-LAB.md`。  
> 有 Windows 时再跑 `ops/WINDOWS-DRILL-RUNBOOK.md`。  
> Node **≥ 22.6**。LNA L2 **禁止** loopback→loopback。回传去 EXIF；仓库 PUBLIC。

## 目录

```text
channel/           WSS 服务、证书生成、浏览器探针、三类清单
cold-start/        最小 Electron app:// 壳 + 安全基线 + 清单
ab-upgrade/        A/B 状态机演练脚本 + 支持矩阵样例
ops/               Windows 总 runbook + 回传模板
test/              离线单测
```

## 快速开始（无 Windows — 当前默认）

```bash
cd tools/spikes/m0-4-edge
npm install
npm run lab:offline   # 单测 + 证书 + A/B + 快照恢复（不启 Electron）
```

本机可选增强（macOS 也可）：

```bash
npm run cert && npm run wss          # 浏览器 L1
node cold-start/print-runbook.mjs
cd cold-start/electron-app && npm i && npm start
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
