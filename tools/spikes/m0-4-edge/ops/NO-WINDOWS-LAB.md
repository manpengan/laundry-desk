# 无 Windows 实验室路径（当前默认）

> **现状（2026-07-20）**：开发侧 **没有 Windows 测试机、没有接打印机**。  
> M0-4 的 Windows 专属项（证书信任 UX、Chrome LNA 真公网、防火墙弹窗、断电冷启动录屏）**全部挂起**，以 macOS/Linux 可跑路径替代取证。

## 本机可完成（macOS/Linux）

```bash
cd tools/spikes/m0-4-edge
npm install
npm run lab:offline    # 单测 + 证书 + A/B 剧本 + 快照恢复（不启 Electron）
```

可选（本机有图形界面时）：

```bash
npm run cert && npm run wss
# 浏览器打开 https://127.0.0.1:17443/client 做 L1 基线
# L2 公网源仍需公网 HTTPS 页 — 无 Windows 时同样可在 macOS Chrome 做
node cold-start/print-runbook.mjs
cd cold-start/electron-app && npm install && npm start   # 需本机 Electron
```

## 明确延后到有 Windows 时

| 项 | 原因 |
|---|---|
| Windows Defender 防火墙弹窗 | 仅 Windows |
| 证书导入「受信任根」店员路径 | Windows 证书存储 UX |
| OS 断电冷启动 | 需 Windows 实机重启 |
| 企业安全软件（360/火绒） | 柜台 Windows 环境 |

## 与验收关系

- **M0-4 已判通过（降级）**：演练包 + 离线状态机单测成立。  
- 通道最终形态（WSS 证书 vs 消息层加密）**不得**仅凭 macOS L1 定案；L2 公网源可在任一桌面 Chrome 补做。  
- findings 状态保持「Windows 现场挂起」。
