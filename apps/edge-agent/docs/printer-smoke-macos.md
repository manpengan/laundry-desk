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

上面的固定载荷仅用于诊断，不可作为正式验收。正式记录前，必须在正常 App 会话中让一笔
真实订单完成 server 签名派发、CUPS 提交和设备签名回执上传，再使用该派发的 `job_id`：

```bash
pnpm --filter @laundry/edge-agent printer-acceptance:mac -- --job-id <uploaded-signed-dispatch-uuid>
```

七项（中文、金额、走纸、切/撕、条码、断连不重复、显式重打仅一份）全部确认后，才会在
当前用户的 Application Support 私有目录写入 `0600` JSON。记录保存真实 snapshot SHA-256、
receipt sequence 以及 job/队列/CUPS job 的 SHA-256 指纹，不保存原始设备名、客户数据或
照片。自动化、无 TTY、找不到已上传成功的签名回执或漏确认任一项时均不生成记录。
