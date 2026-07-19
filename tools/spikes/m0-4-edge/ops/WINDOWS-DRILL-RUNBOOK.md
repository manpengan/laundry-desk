# M0-4 Windows 总演练包（交 manpengan 现场执行）

> 本机若无 Windows / 无实机：开发侧已交付脚本与单测；本清单在 Windows 10/11 柜台测试机上跑完并回传结果。

## 红线

- 回传截图/录屏 **先去 EXIF / 敏感元数据**；按 **仓库 PUBLIC** 处理（无真实客户数据、无内网拓扑细节）。
- Node **≥ 22.6**（`package.json` engines）。

## 0. 准备

```powershell
git fetch origin grok/m0-spikes
git checkout grok/m0-spikes
cd tools\spikes\m0-4-edge
node -v   # >= 22.6
npm install
```

安装 OpenSSL（证书生成）：Git for Windows 自带或 `choco install openssl`。

## 1. 本地通道（证书 / LNA / 防火墙）— 约 30–45 min

```powershell
npm run cert
# 确认 channel\certs\meta.json method=openssl
npm run wss
```

另开窗口按：

1. `channel/CERT-TRUST-CHECKLIST.md`
2. `channel/LNA-CHECKLIST.md` — **L2 必须用公网 HTTPS 源或非 loopback origin**（loopback→loopback 无效）
3. `channel/FIREWALL-CHECKLIST.md`

把表格填进 `ops/FIELD-RESULTS.md`。

## 2. 断网冷启动 — 约 20 min + 一次重启

```powershell
node cold-start\print-runbook.mjs
cd cold-start\electron-app
npm install
npm start
```

按 `cold-start/COLD-START-CHECKLIST.md`：

1. 在线冒烟 + 安全基线  
2. 拔网线重启应用  
3. **断电/重启 OS**，保持断网，再 `npm start`  
4. 篡改 `spa\index.html` 验证完整性失败（改完请用 print-runbook 恢复 manifest）

**证据形式：短录屏（优先）**，不要只交静态照片。录屏需覆盖：启动 → 显示 app:// 工作台 → ping 成功 →（可选）断网再启。

## 3. A/B 升级 + 快照回滚 — 约 20 min

```powershell
cd ..\..   # back to m0-4-edge
npm run ab:init
npm run ab:install-fail    # 期望：不切换主槽
npm run ab:init
npm run ab:install-ok      # 期望：切到 B / 2.0.0
npm run ab:rollback-ok     # 强制 flag 兼容 → ACTIVE（对照）
npm run ab:init
npm run ab:install-ok
npm run ab:rollback-matrix # ★ 裸 rollback：走 support-matrix.sample.json 真判定
# 期望：2.0.0 → 可回 1.9.0（rollbackReadsSchema=true）

npm run ab:init
node ab-upgrade\drill.mjs install-standby --health pass --version 2.1.0 --migrate contract
npm run ab:rollback-matrix # ★ 裸 rollback：matrix 禁止 → RECOVERY_MODE
npm run ab:rollback-blocked   # flag 对照仍可跑

# --- 快照 → 人为损坏 → 恢复 → sha256 一致 ---
npm run ab:init
npm run ab:snapshot
node -e "const fs=require('fs');const p='ab-upgrade/slots/A/db.spike';fs.writeFileSync(p,'CORRUPTED');"
# 确认已损坏
Get-FileHash ab-upgrade\slots\A\db.spike -Algorithm SHA256
npm run ab:restore
Get-FileHash ab-upgrade\slots\A\db.spike -Algorithm SHA256
# 与 snapshots 目录最新文件 hash 一致；content 不再是 CORRUPTED
Get-Content ab-upgrade\slots\A\db.spike
npm test
```

可选一行对比脚本：

```powershell
node -e "const fs=require('fs'),c=require('crypto'),path=require('path');const snapDir='ab-upgrade/slots/snapshots';const snaps=fs.readdirSync(snapDir).sort();const latest=snaps[snaps.length-1];const h=f=>c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');const a=h('ab-upgrade/slots/A/db.spike');const b=h(path.join(snapDir,latest));console.log({latest,active:a,snap:b,match:a===b});"
```

## 4. 回传

复制 `ops/FIELD-RESULTS-TEMPLATE.md` → `ops/FIELD-RESULTS.md`，附：

- Chrome/Edge 版本号  
- 证书警告（可截图，去 EXIF）  
- **冷启动录屏**（非仅照片）  
- L2 公网 origin 原文 + LNA 弹窗结果  
- 快照恢复 hash 一致输出  
- `npm test` 输出  

结论由 Grok 合并进 `docs/research/2026-07-19-v2-m0-findings.md` 的 M0-4 小节。
