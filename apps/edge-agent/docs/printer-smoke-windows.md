# Windows 打印机 path 冒烟（XP-58 / COM / USB）

操作员在装机或接 XP-58 后，用 CLI 验证 `LAUNDRY_PRINTER_PATH`，**不必**打开完整柜台 SPA。  
无 `node-usb`：产品配置只接受 Windows COM/LPT/USB 设备端点，不接受任意文件路径。

相关实现：`src/print/printer-smoke.ts`、`src/print/usb-port.ts`。

## 1. 前置

- 已安装仓库依赖，能执行 `pnpm --filter @laundry/edge-agent printer-smoke`
- XP-58 已上电；设备管理器能看到串口或 USB 打印口（常见 `COMn` / `USBnnn`）
- 可选：先关占用该口的其他软件（驱动工具、旧 POS）

## 2. PowerShell 设置环境变量

```powershell
# 仓库根目录
cd <repo-root>

# 推荐：设备命名空间（COM10+ 必须用 \\.\ 前缀）
$env:LAUNDRY_PRINTER_PATH = '\\.\COM3'

# 等价：裸 COM 名（会自动规范成 \\.\COM3）
$env:LAUNDRY_PRINTER_PATH = 'COM3'

# USB 打印支持虚拟口（Device Manager 里常见 USB001）
$env:LAUNDRY_PRINTER_PATH = '\\.\USB001'
# 或
$env:LAUNDRY_PRINTER_PATH = 'USB001'

# 并口设备
$env:LAUNDRY_PRINTER_PATH = 'LPT1'

# 可选写超时（毫秒，默认 5000；绝不无限挂起）
$env:LAUNDRY_PRINTER_SMOKE_TIMEOUT_MS = '3000'
```

CMD：

```bat
set LAUNDRY_PRINTER_PATH=\\.\COM3
pnpm --filter @laundry/edge-agent printer-smoke
```

## 3. 运行

```powershell
# 只校验配置；不会打开设备或写出任何字节
pnpm --filter @laundry/edge-agent printer-smoke -- --validate

# 明确执行物理冒烟：init + 文本 + feed + partial cut
pnpm --filter @laundry/edge-agent printer-smoke
```

退出码：`0` = ok，`1` = 失败。stdout **仅** JSON status（无原始 ESC/POS 字节）。

## 4. 解读 JSON

| 字段            | 含义                                                        |
| --------------- | ----------------------------------------------------------- |
| `ok`            | 探测是否成功                                                |
| `path`          | 规范化后的 path（如 `COM3` → `\\.\COM3`）；mock 时为 `null` |
| `kind`          | `mock` / `usb` / `missing`                                  |
| `message`       | 人读说明；失败时含 access denied / path missing 提示        |
| `bytes_written` | 成功写入的字节数（仅物理冒烟成功；`--validate` 不返回）     |

### 示例

**未设置 path（安全 mock）**

```json
{
  "ok": true,
  "path": null,
  "kind": "mock",
  "message": "Mock print port active ..."
}
```

**配置校验成功（零输出）**

```json
{
  "ok": true,
  "path": "\\\\.\\COM3",
  "kind": "usb",
  "message": "Validated printer device path \\\\.\\COM3 (no bytes written)"
}
```

**真机 COM 成功** — 应出一小段自检文字 + 部分切；`ok=true`，`kind=usb`，`bytes_written>0`。

**path 不存在**

```json
{
  "ok": false,
  "path": "\\\\.\\COM99",
  "kind": "missing",
  "message": "Path missing: ... Check Device Manager ..."
}
```

**占用 / 权限**

```json
{
  "ok": false,
  "path": "\\\\.\\COM3",
  "kind": "usb",
  "message": "Access denied writing ... Close other apps using the port ..."
}
```

## 5. XP-58 提示

- 默认 ESC/POS；冒烟载荷为 init + 一行英文 + feed + partial cut（`GS V`）
- 中文 / 全角 ￥ / CODE128 全票请用 M0-3 spike 样张 + 本 lab `CHECKLIST.md` XP-58 表
- 若只「写成功」但不出纸：查驱动是否抢占 RAW、换 USB 口、确认打印机非「仅驱动假脱机」
- COM10 及以上务必使用 `\\.\COMxx` 形式（裸 `COM10` 在部分系统不可靠；本工具会自动补前缀）

## 6. 常见失败

| 现象                           | 处理                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `kind=missing` / path missing  | 设备管理器确认 COM/USB 号；线材 / 供电；换口后再设 env |
| Access denied / EACCES / EPERM | 关闭占用软件；必要时管理员 PowerShell；换口            |
| 超时 `USB write timed out`     | 提高 `LAUNDRY_PRINTER_SMOKE_TIMEOUT_MS`；查卡死驱动    |
| 仅 mock                        | 忘记 `$env:LAUNDRY_PRINTER_PATH`（新开会话需重设）     |

## 7. NSIS / 安装包（后续）

正式 Windows 安装器（NSIS）可将 `LAUNDRY_PRINTER_PATH` 写入用户/机器环境或 Edge 配置。  
**当前**冒烟仅以会话 env + 操作员 CLI 为准；renderer 不提供设备诊断 IPC。安装器接线另任务，不阻塞本 checklist。

## 8. 相关

- Lab 勾选：`tools/lab/printers/CHECKLIST.md`（含 Windows 节）
- Edge README：`apps/edge-agent/README.md` → 打印机 path 冒烟
- 安全边界：renderer/preload 不暴露 printer-smoke；仅 CLI 可触发物理输出
