# 现场清单 · Gprinter GP-3120 不干胶（TSPL）

操作人：manpengan  
全变量（长标签）：`out/gp3120-sticker-fullvars.bin`（SIZE 40×60）  
紧凑生产：`out/gp3120-sticker-compact.bin`（SIZE 40×30）

## 接机

1. USB 或网口；网口常用 `9100` raw。
2. 确认耗材宽度（常见 40mm）与间隙（GAP）；与脚本 `SIZE`/`GAP` 不一致会错位。
3. 驱动：优先 **TSPL RAW**；避免 Windows 光栅驱动。

## 发送

```powershell
npm run generate
# USB/COM
powershell -File .\send\send-windows.ps1 -File .\out\gp3120-sticker-compact.bin -Port COM5
# 网口示例
powershell -File .\send\send-windows.ps1 -File .\out\gp3120-sticker-compact.bin -Tcp "192.168.x.x:9100"
```

建议：先打 **compact** 校准尺寸，再打 **fullvars** 核对 22 变量。

## 验收勾选

| # | 检查项 | 结果 Y/N | 备注 |
|---|---|---|---|
| 1 | 中文 TSS 字体正常（非方框） |  | 缺字库→换 `TSS24.BF2`/`SIMHEI.TTF` 等 |
| 2 | 22 个变量均出现（fullvars） |  | 对照 `out/sticker-vars-rendered.txt` |
| 3 | 含 `@已消毒@` `@打开存放@` |  | 不干胶相对水洗唛增量 |
| 4 | 付款方式行含欠款语义 |  | sample 为「微信/已清」 |
| 5 | 条码可扫 |  | |
| 6 | 间隙定位准确、不重影 |  | 调 GAP / 偏移 |
| 7 | compact 四行信息完整 |  | |

## 尺寸校准记录

- 实际标签 mm：宽____ × 高____
- 生效 `SIZE`：________
- 生效 `GAP`：________
- 字体名：________

## 已知坑（回填）

- `SIZE` 单位写错（inch vs mm）导致只打一行。
- 部分固件要 `CODEPAGE 936` 才出中文（若乱码，在 TSPL 头加 `CODEPAGE 936` 再测）。
- USB 复合设备：需关掉「打印首选项」里的软件剪切。

## 结论

- 指令族：TSPL
- 样张：通过 / 不通过 / 需改设计：________
