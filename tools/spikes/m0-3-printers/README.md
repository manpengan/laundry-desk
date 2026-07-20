# M0-3 · 三类打印机实机 spike

**目标**：用宏发现役三台验证指令族与变量渲染——

| 机型 | 用途 | 指令族（假设） | 生成物 |
|---|---|---|---|
| XP-58 | 小票 58mm | ESC/POS + GBK | `out/xp58-receipt.bin` |
| DASCOM DL-206 | 水洗唛 + **切刀** | ESC/POS + 切刀变体 | `out/dl206-wash-*.bin` |
| Gprinter GP-3120 | 不干胶 | TSPL | `out/gp3120-sticker-*.bin` |

变量真源：顺科矩阵 IMG_2315/2316（水洗唛命名变量全集 / 不干胶 22 变量）。  
金额：**整数分**，渲染为全角 **￥**（U+FFE5，GBK 安全）。

> **现状（2026-07-20）**：开发侧 **无打印机、无 Windows 测试机**。  
> 默认走 **离线 lab**（`npm run lab:offline`）；实机出纸挂起，见 `ops/NO-PRINTER-LAB.md`。  
> 有机后再按 `ops/CHECKLIST-*.md` 执行并回传 `FIELD-RESULTS.md`。

## 目录

```text
fixtures/sample-order.json   # 虚构样张数据（13800000xxx）
lib/                         # money / encode / escpos / tspl / variables
src/                         # 三台生成器 + generate-all
send/                        # Node + PowerShell 原始发送
ops/                         # 逐台操作清单与回传模板
out/                         # npm run generate 输出（bin + hex + 变量清单）
test/                        # 离线单测（不依赖硬件）
```

## 红线

- 回传照片 **去 EXIF**；材料按 **仓库 PUBLIC**（虚构 PII only）。
- Node **≥ 22.6**。Windows 发 COM **优先 `node send/send-raw.mjs`**（PS 5.1 `-Port` 不可靠）。

## 快速开始（无打印机 — 当前默认）

```bash
cd tools/spikes/m0-3-printers
npm install
npm run lab:offline    # test + generate + verify + mock-send
```

有打印机时再：

```bash
npm run generate
node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3
```

生成物要点：

- `xp58-receipt*.bin`：默认 CODE128 **{B/{C + GS w 1**，另有 b/bc × w1/w2 变体  
- `gp3120-sticker-fullvars.bin`：**SIZE 40×90**（条码不出画）  
- `boundary-{empty,long,special}-*.bin`：空值 / 长中文 / 特殊字符  

## 发送到实机

见 `ops/CHECKLIST-xp58.md`、`CHECKLIST-dl206.md`、`CHECKLIST-gp3120.md`。

通用：

```bash
node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3
node send/send-raw.mjs --file out/gp3120-sticker-compact.bin --target 192.168.1.50:9100
node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3 --dry-run
```

## 验收标准（对照实现计划 M0-3）

1. 三台各出正确样张  
2. 水洗唛切刀动作正确  
3. 变量渲染无误（水洗唛命名全集 / 不干胶 22）  
4. 指令族与坑写入 `docs/research/2026-07-19-v2-m0-findings.md`

## 红线

- 本目录是 **spike**，不是生产 `apps/edge-agent` 驱动；结论落地后再进 M1 D4。  
- 不在 Edge 写业务校验；样张数据为虚构 PII。  
- 金额零浮点（见 `lib/money.ts`）。
