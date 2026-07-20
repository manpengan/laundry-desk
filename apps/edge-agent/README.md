# `@laundry/edge-agent` — Local Edge Agent（D1 壳）

Electron 壳：`app://` 内置 SPA、断网冷启动路径、ADR-01 安全基线。

**本包边界**：无业务校验；校验语义全在 server 命令总线。D2/D3/D4/D5 后续迭加。

## 安全基线（九项）

| 项                       | 位置                                      |
| ------------------------ | ----------------------------------------- |
| `nodeIntegration: false` | `src/lib/security-prefs.ts` → `window.ts` |
| `contextIsolation: true` | 同上                                      |
| `sandbox: true`          | 同上                                      |
| `webSecurity: true`      | 同上                                      |
| 最小 preload 白名单      | `src/preload.ts`（仅 `edgeBridge.ping`）  |
| IPC sender 校验          | `src/ipc.ts` + `isValidAppSender`         |
| 禁新窗口                 | `setWindowOpenHandler` deny               |
| 禁外链导航               | `will-navigate` 仅 `app://`               |
| 权限默认拒绝             | `setPermissionRequestHandler` → false     |

## 开发

```bash
# 从仓库根
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent typecheck
pnpm --filter @laundry/edge-agent build

# 启动壳（需先 build；依赖根或本包 electron）
pnpm exec electron apps/edge-agent
```

内置 SPA 资产：`resources/spa/`（`manifest.json` 的 `indexSha256` 须与 `index.html` 一致）。
篡改 index 后启动应失败退出——这是冷启动完整性闸。

## M1 范围说明

- 完整性：SHA-256 自证（生产将换非对称签名 + 证书钉扎）
- SPA：占位离线工作台，非业务页
- 未做：配对/签名、SQLCipher 队列、打印、A/B 双槽（D2–D5）
