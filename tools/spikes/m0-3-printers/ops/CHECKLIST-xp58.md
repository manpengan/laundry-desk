# 现场清单 · XP-58 小票（ESC/POS · 58mm）

操作人：manpengan　样张文件：`out/xp58-receipt.bin`

## 接机

1. USB 连接测试机；确认 Windows 设备管理器出现 USB Printing Support 或 COM 口。
2. 记录映射：`PrinterName=________` / `Port=COM__` / 驱动是否为「Generic / Text Only」。
3. 装纸：58mm 热敏，纸张末端朝上（按机型箭头）。

## 发送

在 `tools/spikes/m0-3-printers` 目录：

```powershell
npm install
npm run generate
# 方式 A：COM 口
powershell -File .\send\send-windows.ps1 -File .\out\xp58-receipt.bin -Port COM3
# 方式 B：打印机共享名
powershell -File .\send\send-windows.ps1 -File .\out\xp58-receipt.bin -PrinterName "XP-58"
# 方式 C：Node 通用
node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3
```

## 验收勾选

| # | 检查项 | 结果 Y/N | 备注 |
|---|---|---|---|
| 1 | 出纸且无乱码（中文可读） |  | 乱码→编码/代码页问题 |
| 2 | 店名居中加粗 |  | |
| 3 | 票单号 `20260719-0001` |  | |
| 4 | 明细两行金额合计 ¥60.00 |  | **整数分渲染** |
| 5 | 手机号脱敏 `138****0138` |  | |
| 6 | 条码可扫（CODE128） |  | |
| 7 | 顾客须知三行完整 |  | |
| 8 | 部分切刀/撕纸位合理 |  | XP-58 多为撕纸无全切 |

## 已知坑（回填）

- 中文乱码：确认发送的是 **RAW GBK**，不是系统 GDI 驱动二次渲染。
- 驱动吞命令：必须 RAW / Generic Text Only，不能用 Windows 图片驱动。
- USB 枚举名：插拔后 COM 号会变，以设备管理器为准。

## 结论

- 指令族：ESC/POS（GBK）
- 样张：通过 / 不通过 / 需改设计：________
- 照片/扫描件路径：________
