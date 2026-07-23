# 三类打印机实机样张清单

> 状态：模板（待接机）  
> 机型：XP-58 小票 / DASCOM DL-206 水洗唛 / Gprinter GP-3120 不干胶  
> 相关：M0-3 spike；正式 D4 等 Codex job/receipt schema

## 红线

- 金额必须为全角 **￥**（U+FFE5），禁止半角 ¥ 在 GBK 载荷中出现 `?`（0x3F）
- 证据去 EXIF；禁止真实客户 PII
- 无打印机时只可标「代码侧 / mock spool」

## 每机勾选

### XP-58（ESC/POS）

| 项           | Y/N | 备注                  |
| ------------ | --- | --------------------- |
| 中文清晰     |     |                       |
| 金额 ￥ 正确 |     |                       |
| CODE128 可读 |     |                       |
| 样张文件     |     | `evidence/xp58-*.jpg` |

### DL-206（水洗唛 + 切刀）

| 项         | Y/N | 备注                    |
| ---------- | --- | ----------------------- |
| 全变量渲染 |     |                         |
| 切刀稳定   |     | GS V / ESC i 哪条生效： |
| 样张文件   |     |                         |

### GP-3120（TSPL 不干胶）

| 项                | Y/N | 备注 |
| ----------------- | --- | ---- |
| SIZE 与条码不裁切 |     |      |
| 引号转义          |     |      |
| 样张文件          |     |      |

## 离线替代（无打印机）

```bash
cd tools/spikes/m0-3-printers && npm test && npm run lab:offline
```

结论只能写：**代码侧通过 / 待实机**。

## M2 Edge · `LAUNDRY_PRINTER_PATH` 冒烟（无 UI）

装机 / 接机后，用 edge-agent 的 pure probe 验证 path，不必开完整 SPA：

| 步 | 命令 | 期望 |
| -- | ---- | ---- |
| 1 | `pnpm --filter @laundry/edge-agent printer-smoke` | `ok=true`, `kind=mock`，message 提示设置 env |
| 2 | `LAUNDRY_PRINTER_PATH=/tmp/laundry-spool.bin pnpm --filter @laundry/edge-agent printer-smoke` | `ok=true`, `kind=usb`, `bytes_written>0`，文件有 ESC `@` 头 |
| 3 | 真机：设 path 为设备节点（如 `/dev/usb/lp0`）或 Windows COM/USB，再跑同上 | 出纸一小段自检行 + 切刀；`ok=true` |
| 4 | path 指不存在文件 | `ok=false`, `kind=missing` |

可选超时：`LAUNDRY_PRINTER_SMOKE_TIMEOUT_MS=3000`（默认 5s，写路径绝不无限挂起）。

实现：`apps/edge-agent/src/print/printer-smoke.ts`（`runPrinterSmoke`）+ CLI `printer-smoke` script；IPC `edge:printer-smoke` 同 status JSON。

| 项 | Y/N | 备注 |
| -- | --- | ---- |
| mock 冒烟 |  | |
| 文件 spool 冒烟 |  | |
| 真机 path 冒烟 |  | path= |
| 超时/失败路径可读 |  | |

## Windows · COM / USB 冒烟（XP-58）

短指南：[`apps/edge-agent/docs/printer-smoke-windows.md`](../../../apps/edge-agent/docs/printer-smoke-windows.md)

### 路径形式（`LAUNDRY_PRINTER_PATH`）

| 形式 | 示例 | 说明 |
| ---- | ---- | ---- |
| COM 裸名 | `COM3` | 自动规范为 `\\.\COM3` |
| 设备命名空间 | `\\.\COM3` | COM10+ 推荐 / 必须 |
| USB 虚拟口 | `USB001` / `\\.\USB001` | 设备管理器「USB 打印支持」常见 |
| 文件重定向 | `%TEMP%\laundry-spool.bin` | 无硬件先验 CLI / 载荷 |

### PowerShell 一步

```powershell
$env:LAUNDRY_PRINTER_PATH = '\\.\COM3'
pnpm --filter @laundry/edge-agent printer-smoke
```

### 勾选

| 项 | Y/N | 备注 |
| -- | --- | ---- |
| mock（未设 env） |  | `kind=mock` |
| 文件 spool |  | `%TEMP%` 重定向 |
| COM 真机 |  | path= `\\.\COM__` |
| USB001 真机 |  | 若适用 |
| XP-58 出纸 + 切/撕 |  | |
| access denied 可读 |  | 关占用后再试 |
| path missing 可读 |  | 错口号 |

### 常见失败

| 症状 | 处理 |
| ---- | ---- |
| Access denied / EACCES / EPERM | 关闭占用 COM 的软件；管理员壳；换口 |
| Path missing / `kind=missing` | 设备管理器核对 COM/USB 号；线材与供电 |
| 写超时 | 调大 `LAUNDRY_PRINTER_SMOKE_TIMEOUT_MS`；查驱动卡死 |
| 仅 mock | 新开终端未继承 env；重设 `$env:LAUNDRY_PRINTER_PATH` |
| 文件有字节但不出纸 | path 仍是 spool 文件，未改成 COM/USB |

### NSIS / 安装包（后续）

正式 NSIS 安装器可把打印机 path 写入用户环境或 Edge 配置。  
**当前**以会话 env + `pnpm printer-smoke` / IPC 为准；安装器接线不阻塞本 lab。

操作人：________ 日期：________ OS：Windows ____ COM/USB：________
