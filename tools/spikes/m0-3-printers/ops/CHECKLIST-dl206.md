# 现场清单 · DASCOM DL-206 水洗唛（含切刀）

操作人：manpengan　主样张：`out/dl206-wash-fullvars.bin`  
切刀备选：`out/dl206-wash-cut-esc-i.bin`

## 接机

1. USB 连接；记录 `Port` / `PrinterName`。
2. 装水洗唛耗材（注意热敏面与走纸方向）。
3. 确认机型面板/驱动中 **切刀启用**。

## 发送顺序

1. 先打 `dl206-wash-fullvars.bin`（含 `GS V 0` 全切）。
2. 若只出纸不切 → 再打 `dl206-wash-cut-esc-i.bin`（`ESC i`）。
3. 仍不切 → 记录固件版本，试 `ESC m`（需改生成器后重打）。

```powershell
npm run generate
powershell -File .\send\send-windows.ps1 -File .\out\dl206-wash-fullvars.bin -Port COM4
powershell -File .\send\send-windows.ps1 -File .\out\dl206-wash-cut-esc-i.bin -Port COM4
```

## 验收勾选

| # | 检查项 | 结果 Y/N | 备注 |
|---|---|---|---|
| 1 | 中文变量全部可读 |  | 对照 `out/wash-vars-rendered.txt` |
| 2 | 变量条数与文件一致（当前生成 **23** 个命名变量；矩阵文案写 21） |  | 差异写入 findings |
| 3 | `@票单号@` `@条码号@` `@挂点@` 正确 |  | |
| 4 | **切刀动作**发生且切口干净 |  | 记成功指令：GS V / ESC i / 其他 |
| 5 | 切后无连续空走纸失控 |  | |
| 6 | 紧凑三行块可用于生产模板基线 |  | |

## 切刀结论（必填）

- 生效指令字节：________（例：`1D 56 00` 或 `1B 69`）
- 切前是否需要额外 feed：________
- 固件/驱动版本：________

## 已知坑（回填）

- 部分 DASCOM 固件忽略 `GS V`，只认 `ESC i`。
- 水洗唛介质厚度导致半切失败 → 改全切或加大 feed。
- 若设备实际是 TSPL/CPCL 方言而非 ESC/POS，本样张会整页乱码 → **立即停，回传十六进制自检页**，改设计驱动族。

## 结论

- 指令族：________
- 样张：通过 / 不通过 / 需改设计：________
