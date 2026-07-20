# 无打印机实验室路径（当前默认）

> **现状（2026-07-20）**：开发侧 **没有接 XP-58 / DL-206 / GP-3120**，也无 Windows 发 COM 的测试机。  
> 实机验收 **挂起**；以「指令流正确性 + 离线 verify」代替出纸证据。

## 本机必做（macOS/Linux 均可）

```bash
cd tools/spikes/m0-3-printers
npm install
npm test
npm run generate
npm run verify          # 检查 bin 协议标记 / ￥ GBK / 无 0x3F / 边界样张齐全
npm run mock-send       # 把默认样张「发送」到 out/mock-spool/（不碰硬件）
```

`verify` 通过 = 生成器侧门禁绿；**不等于**实机切刀/字库/耗材 OK。

## 有机时再做

按 `CHECKLIST-xp58.md` / `CHECKLIST-dl206.md` / `CHECKLIST-gp3120.md` 在 Windows 测试机 RAW 发送；回传 `FIELD-RESULTS.md`（去 EXIF）。

## 与验收关系

- 任务书 M0-3 门禁含「三台各出正确样张」→ **缺硬件时只能有条件通过**。  
- 演练包已就绪；实机日排期后一次性跑清单，避免白烧耗材（已知陷阱：半角 ¥、CODE128 码集、切刀 feed 已预埋变体）。
