# 现场清单 · DASCOM DL-206 水洗唛（含切刀）

操作人：manpengan　主样张：`out/dl206-wash-fullvars.bin`  
切刀备选：
- `out/dl206-wash-cut-esc-i.bin`（`ESC i`）
- `out/dl206-wash-cut-feed.bin`（`feed(6)` + `GS V 66 n` 走纸到切刀位再全切）

## 红线（回传前必读）

- 样张照片 **先去 EXIF**（时间/GPS/设备序列号）。
- 材料按 **仓库 PUBLIC** 处理：禁止真实客户 PII / 真实门店票。

## 接机

1. USB 连接；记录 `Port` / `PrinterName`。
2. 装水洗唛耗材（注意热敏面与走纸方向）。
3. 确认机型面板/驱动中 **切刀启用**。

## 发送顺序

1. 先打 `dl206-wash-fullvars.bin`（短 feed + `GS V 0` 全切）。
2. 若**切进内容**（切口在字上）→ 打 `dl206-wash-cut-feed.bin`（加长走纸 + `GS V 66 n`）。
3. 若只出纸**不切** → 再打 `dl206-wash-cut-esc-i.bin`（`ESC i`）。
4. 仍不切 → 记录固件版本，试 `ESC m`（需改生成器后重打）。

```powershell
npm run generate
# 首选 Node（PS 5.1 -Port 不可靠）
node send/send-raw.mjs --file out/dl206-wash-fullvars.bin --target COM4
node send/send-raw.mjs --file out/dl206-wash-cut-feed.bin --target COM4
node send/send-raw.mjs --file out/dl206-wash-cut-esc-i.bin --target COM4
# 或共享名
powershell -File .\send\send-windows.ps1 -File .\out\dl206-wash-fullvars.bin -PrinterName "DL-206"
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

## 边界样张（可选）

`out/boundary-empty-dl206.bin` / `boundary-long-dl206.bin` / `boundary-special-dl206.bin`

## 切刀结论（必填）

- 生效文件：fullvars / cut-feed / cut-esc-i / 其他：________
- 生效指令字节：________（例：`1D 56 00` / `1D 56 42 03` / `1B 69`）
- 切前是否需要额外 feed：________（cut-feed 已预置 feed(6)+GS V 66）
- 固件/驱动版本：________

## 已知坑（回填）

- 部分 DASCOM 固件忽略 `GS V`，只认 `ESC i`。
- 水洗唛介质厚度导致半切失败 → 改全切或加大 feed。
- 若设备实际是 TSPL/CPCL 方言而非 ESC/POS，本样张会整页乱码 → **立即停，回传十六进制自检页**，改设计驱动族。

## 结论

- 指令族：________
- 样张：通过 / 不通过 / 需改设计：________
- 证据（去 EXIF）：________
