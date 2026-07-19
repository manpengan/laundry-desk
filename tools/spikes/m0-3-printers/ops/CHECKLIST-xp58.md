# 现场清单 · XP-58 小票（ESC/POS · 58mm）

操作人：manpengan　默认样张：`out/xp58-receipt.bin`（CODE128 **{B/{C 混合 + GS w 1**）

## 红线（回传前必读）

- 样张/失败照片 **先去 EXIF**（时间/GPS/设备序列号），再外发。
- 回传材料默认按 **仓库 PUBLIC** 处理：禁止真实客户 PII、真实门店票据、未脱敏手机号。
- 本 spike 仅虚构数据（`13800000xxx`）。

## 接机

1. USB 连接测试机；确认 Windows 设备管理器出现 USB Printing Support 或 COM 口。
2. 记录映射：`PrinterName=________` / `Port=COM__` / 驱动是否为「Generic / Text Only」。
3. 装纸：58mm 热敏，纸张末端朝上（按机型箭头）。

## 发送（优先 Node）

在 `tools/spikes/m0-3-printers` 目录：

```powershell
npm install
npm run generate
# ★ 首选：Node 直写 COM / 共享名（PowerShell 5.1 的 -Port 不可靠）
node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3
# 或打印机共享名（Generic / Text Only + RAW）
powershell -File .\send\send-windows.ps1 -File .\out\xp58-receipt.bin -PrinterName "XP-58"
# TCP 9100（若转网络盒）
node send/send-raw.mjs --file out/xp58-receipt.bin --target 192.168.x.x:9100
```

> `send-windows.ps1 -Port`：Windows PowerShell **5.1 常拒开 COM**。请用上面 Node 方式；若必须 PS，用 **pwsh 7+** 且优先 `-PrinterName` 共享。

## 验收勾选

| # | 检查项 | 结果 Y/N | 备注 |
|---|---|---|---|
| 1 | 出纸且无乱码（中文可读） |  | 乱码→编码/代码页问题 |
| 2 | 店名居中加粗 |  | |
| 3 | 票单号 `20260719-0001` |  | |
| 4 | 明细两行金额合计 ¥60.00 |  | **整数分渲染** |
| 5 | 手机号脱敏 `138****0138` |  | |
| 6 | 条码可扫（CODE128） |  | 见下方「条码不出→换变体」 |
| 7 | 顾客须知三行完整 |  | |
| 8 | 部分切刀/撕纸位合理 |  | XP-58 多为撕纸无全切 |

## 条码不出 → 换变体（必修分支）

默认 bin 已带 **`{B`/`{C` 码集前缀**。若条码空白、被裁切、无法扫描：

| 顺序 | 文件 | 说明 |
|---|---|---|
| 0 | `out/xp58-receipt.bin` | BC + GS w **1**（默认，适配 384dot） |
| 1 | `out/xp58-receipt-bc-w1.bin` | 同默认，显式标签 |
| 2 | `out/xp58-receipt-b-w1.bin` | 纯 `{B` + w1 |
| 3 | `out/xp58-receipt-bc-w2.bin` | BC + w2（较宽，可能贴边） |
| 4 | `out/xp58-receipt-b-w2.bin` | 纯 `{B` + w2（**易超 384dot**，对照用） |

```powershell
node send/send-raw.mjs --file out/xp58-receipt-b-w1.bin --target COM3
```

记录：**第一个成功的变体文件名** = ________  
对照 `out/code128-width-plan.txt` 的点宽估算。

## 边界样张（可选同日）

| 文件 | 场景 |
|---|---|
| `out/boundary-empty-xp58.bin` | 空值变量 |
| `out/boundary-long-xp58.bin` | 中文长文本 |
| `out/boundary-special-xp58.bin` | `@` / 引号 / 换行 |

## 已知坑（回填）

- 中文乱码：确认发送的是 **RAW GBK**，不是系统 GDI 驱动二次渲染。
- 驱动吞命令：必须 RAW / Generic Text Only，不能用 Windows 图片驱动。
- 无 `{B`/`{C` 前缀的 CODE128 在多数固件上 **整条不打**。
- 纯 B + GS w 2 + 16 字符 ≈ **>384dot**，58mm 可打宽内会裁切。

## 结论

- 指令族：ESC/POS（GBK）
- 生效条码变体：________
- 样张：通过 / 不通过 / 需改设计：________
- 证据（去 EXIF 照片或短视频）路径：________
