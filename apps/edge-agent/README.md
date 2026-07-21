# `@laundry/edge-agent` — Local Edge Agent（D1 壳 + D2 配对 + D4 打印骨架 + D5）

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

| 通道                                     | 用途                                              |
| ---------------------------------------- | ------------------------------------------------- |
| `edge:ping`                              | 存活探测                                          |
| `edge:health`                            | SPA/manifest 存在性                               |
| `edge:upgrade-status`                    | D5 状态机只读投影                                 |
| `edge:connection`                        | 连接条 mock（待 E1）                              |
| `edge:print-enqueue` / `edge:print-list` | D4：入队+执行（status only，无设备路径/原始字节） |
| `pairing:createCode`                     | D2：签发 60s 一次性配对码 + 确保设备公钥          |
| `pairing:status`                         | D2：是否有设备公钥 / 当前码是否仍有效（无私钥）   |

## D2 配对 / 票据（pure core）

| 模块                           | 职责                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `src/pairing/one-time-code.ts` | 60s 六位一次性码；过期与双消费拒绝                                  |
| `src/pairing/device-keys.ts`   | `DeviceKeyStore` 端口 + `MemoryDeviceKeyStore`；生产走 keytar/DPAPI |
| `src/pairing/verify-ticket.ts` | A4 能力票据：canonical 验签 + device/origin audience + 过期         |
| `src/pairing/sign-receipt.ts`  | 设备私钥签执行回执（A4 domain + contracts canonical）               |

**红线**：设备私钥永不进入 renderer / preload / IPC 返回值；生产私钥仅 OS 凭据区。

## D4 打印（模板渲染 + XP-58 + print_jobs 回执）

| 模块                           | 职责                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/print/template-render.ts` | 票面变量纯渲染：分→￥（money-gbk）、CODE128 宽度（code128-width）  |
| `src/print/escpos-xp58.ts`     | 最小 ESC/POS（init / 文本行 / cut）；无 USB                        |
| `src/print/print-jobs.ts`      | 状态机 queued→printing→done\|failed + A4 执行回执 payload          |
| `src/print/executor.ts`        | mock spool 执行；失败写 error；不阻塞；产出 receipt 供 signReceipt |
| `src/print/mock-spool.ts`      | 本地 mock 队列镜像（半步）                                         |

IPC 只返回 status 视图（id/kind/status/timestamps/error），不暴露设备路径、原始字节、ticketNonce。

## 开发

```bash
pnpm --filter @laundry/contracts build
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent build
pnpm exec electron apps/edge-agent
```

内置 SPA：`resources/spa/`（改 `index.html` 后须重算 `manifest.json` 的 `indexSha256`）。

## 范围

- ✅ D1 壳 + 单实例 + 托盘 + 健康/升级 IPC
- ✅ D2 配对码 + 设备密钥端口 + 能力票据验签 + 执行回执签名（骨架）
- ✅ D4 签名打印模板本地渲染 + XP-58 ESC/POS 骨架 + print_jobs 回执
- ✅ D5 A/B 状态机骨架
- ⏳ D3 SQLCipher / 真机 USB / OS keytar 适配器
