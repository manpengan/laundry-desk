# 断网冷启动演练清单（app:// 内置签名 SPA）

## 前置

```bash
cd tools/spikes/m0-4-edge
node cold-start/print-runbook.mjs   # 刷新 spa/manifest.json 哈希
cd cold-start/electron-app
npm install
npm start
```

## 验收步骤

| # | 步骤 | 期望 | Y/N |
|---|---|---|---|
| 1 | 在线启动 | 窗口打开本地工作台文案 |  |
| 2 | 日志含 `SPA integrity ok` | 哈希校验通过 |  |
| 3 | UI 显示 `protocol=app:` 或 `app://local/...` | 非远程 URL |  |
| 4 | 点击 ping | `{ok:true, data.mode:"cold-start-spike"}` |  |
| 5 | DevTools 尝试 `require('fs')` | 失败（无 Node 集成） |  |
| 6 | 窗口内点链接/window.open | 被拒绝 |  |
| 7 | **拔网线** 后重启应用 | 仍进入本页 |  |
| 8 | **断电重启 OS** 后断网启动（Windows 现场） | 仍进入本页 |  |
| 9 | 篡改 `spa/index.html` 后启动 | 完整性校验失败退出 |  |

## 安全基线自查（PR/回传必填）

| 项 | 实现位置 | 状态 |
|---|---|---|
| nodeIntegration:false | main.mjs webPreferences |  |
| contextIsolation:true | main.mjs |  |
| sandbox:true | main.mjs |  |
| webSecurity:true | main.mjs |  |
| 最小 preload | preload/preload.mjs |  |
| IPC sender 校验 | edge:ping handler |  |
| 禁新窗口 | setWindowOpenHandler |  |
| 禁外链导航 | will-navigate |  |
| 权限默认拒绝 | setPermissionRequestHandler |  |

## 与生产差异（已知）

- 生产 SPA 验 **非对称签名**（非仅 sha256 自证）  
- 生产有托盘、自动更新、SQLCipher 队列；本 spike 只证明 **加载路径与安全壳**  
