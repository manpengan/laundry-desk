# M0-4 Windows 总演练包（交 manpengan 现场执行）

> 本机若无 Windows / 无实机：开发侧已交付脚本与单测；本清单在 Windows 10/11 柜台测试机上跑完并回传结果。

## 0. 准备

```powershell
git clone <repo>  # 或同步 grok/m0-spikes 分支
cd laundry-desk\tools\spikes\m0-4-edge
node -v   # >= 20
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
2. `channel/LNA-CHECKLIST.md`
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

## 3. A/B 升级 + 快照回滚 — 约 15 min

```powershell
cd ..\..   # back to m0-4-edge
npm run ab:init
npm run ab:install-fail    # 期望：不切换主槽
npm run ab:init
npm run ab:install-ok      # 期望：切到 B
npm run ab:rollback-ok     # 期望：回 ACTIVE
npm run ab:init
node ab-upgrade\drill.mjs install-standby --health pass --version 2.1.0 --migrate contract
npm run ab:rollback-blocked   # 期望：RECOVERY_MODE
npm test
```

## 4. 回传

复制 `ops/FIELD-RESULTS-TEMPLATE.md` → `ops/FIELD-RESULTS.md`，附：

- Chrome/Edge 版本号截图  
- 证书警告截图  
- 冷启动断网照片  
- `npm test` 输出  

结论由 Grok 合并进 `docs/research/2026-07-19-v2-m0-findings.md` 的 M0-4 小节。
