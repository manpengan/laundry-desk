# 现场清单 · Gprinter GP-3120 不干胶（TSPL）

操作人：manpengan  
全变量：`out/gp3120-sticker-fullvars.bin`（**SIZE 40×90 mm**，避免条码出画）  
紧凑生产：`out/gp3120-sticker-compact.bin`（SIZE 40×30）

## 红线（回传前必读）

- 样张照片 **先去 EXIF**；材料按 **仓库 PUBLIC**（禁真实 PII）。

## 接机

1. USB 或网口；网口常用 `9100` raw。
2. 确认耗材宽度（常见 40mm）与间隙（GAP）；fullvars 需 **足够长度**（≥90mm 或现场改 SIZE）。
3. 驱动：优先 **TSPL RAW**；避免 Windows 光栅驱动。

## 发送

```powershell
npm run generate
# 首选 Node
node send/send-raw.mjs --file out/gp3120-sticker-compact.bin --target COM5
node send/send-raw.mjs --file out/gp3120-sticker-fullvars.bin --target COM5
# 网口
node send/send-raw.mjs --file out/gp3120-sticker-compact.bin --target 192.168.x.x:9100
# 或共享名
powershell -File .\send\send-windows.ps1 -File .\out\gp3120-sticker-compact.bin -PrinterName "GP-3120"
```

建议：先打 **compact** 校准尺寸，再打 **fullvars** 核对 22 变量。  
若 fullvars 物理标签只有 30mm 高：只验收 compact + 变量文本清单，fullvars 作指令流回归。

## 验收勾选

| # | 检查项 | 结果 Y/N | 备注 |
|---|---|---|---|
| 1 | 中文 TSS 字体正常（非方框） |  | 缺字库→换字体名 |
| 2 | 22 个变量均出现（fullvars） |  | 对照 `out/sticker-vars-rendered.txt` |
| 3 | 含 `@已消毒@` `@打开存放@` |  | |
| 4 | 付款方式行含欠款语义 |  | sample「微信/已清」 |
| 5 | 条码可扫且 **完整在标签内** |  | 旧 40×60 会裁条码 |
| 6 | 间隙定位准确、不重影 |  | 调 GAP |
| 7 | compact 信息完整 |  | |
| 8 | 特殊字符样张（引号/@）不截断指令 |  | `boundary-special-gp3120.bin` |

## 尺寸校准记录

- 实际标签 mm：宽____ × 高____
- 生效 `SIZE`：________（生成器 fullvars 默认 40×90）
- 生效 `GAP`：________
- 字体名：________

## 已知坑（回填）

- `SIZE` 单位写错（inch vs mm）导致只打一行。
- TEXT 值内 ASCII `"` 会截断命令 → 生成器已转全角 `＂` 并展平换行。
- 部分固件要 `CODEPAGE 936` 才出中文。

## 结论

- 指令族：TSPL
- 样张：通过 / 不通过 / 需改设计：________
- 证据（去 EXIF）：________
