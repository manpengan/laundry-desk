# macOS 实体打印机试点

本试点通过系统 CUPS 队列提交固定 ESC/POS 自检载荷，不向 renderer/preload 暴露任意打印能力。

先只读发现已安装队列：

```bash
pnpm --filter @laundry/edge-agent printer-pilot:mac -- --discover
```

选择返回的精确队列名并只验证、不出纸：

```bash
pnpm --filter @laundry/edge-agent printer-pilot:mac -- --cups-queue XP58_USB --validate
```

确认打印机已装纸且允许出一张自检后，再显式执行：

```bash
pnpm --filter @laundry/edge-agent printer-pilot:mac -- --cups-queue XP58_USB --print
```

成功提交不等于样张验收完成。仍需人工确认文字、走纸、切刀和条码，并按
`tools/lab/printers/CHECKLIST.md` 记录去 EXIF 的证据。
