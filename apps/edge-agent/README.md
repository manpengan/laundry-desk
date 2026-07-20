# `@laundry/edge-agent` — Local Edge Agent（D1 壳 + D5 + mock 打印）

Electron 壳：`app://` 内置 SPA、断网冷启动、ADR-01 安全基线、单实例、托盘。

**本包边界**：无业务校验；校验语义全在 server 命令总线。

## 安全基线（九项）

| 项                       | 位置                                      |
| ------------------------ | ----------------------------------------- |
| `nodeIntegration: false` | `src/lib/security-prefs.ts` → `window.ts` |
| `contextIsolation: true` | 同上                                      |
| `sandbox: true`          | 同上                                      |
| `webSecurity: true`      | 同上                                      |
| 最小 preload 白名单      | `src/preload.ts`                          |
| IPC sender 校验          | `src/ipc.ts` + `isValidAppSender`         |
| 禁新窗口                 | `setWindowOpenHandler` deny               |
| 禁外链导航               | `will-navigate` 仅 `app://`               |
| 权限默认拒绝             | `setPermissionRequestHandler` → false     |

## IPC 白名单（preload）

| 通道                                     | 用途                    |
| ---------------------------------------- | ----------------------- |
| `edge:ping`                              | 存活探测                |
| `edge:health`                            | SPA/manifest 存在性     |
| `edge:upgrade-status`                    | D5 状态机只读投影       |
| `edge:connection`                        | 连接条 mock（待 A4/E1） |
| `edge:print-enqueue` / `edge:print-list` | 打印 mock 队列（待 A4） |

## 开发

```bash
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent build
pnpm exec electron apps/edge-agent
```

内置 SPA：`resources/spa/`（改 `index.html` 后须重算 `manifest.json` 的 `indexSha256`）。

## 范围

- ✅ D1 壳 + 单实例 + 托盘 + 健康/升级 IPC
- ✅ D5 A/B 状态机骨架
- ✅ 打印 mock spool（本地状态，非实机）
- ⏳ D2 配对签名 / D3 SQLCipher / D4 真打印回执 → **等 A4**
