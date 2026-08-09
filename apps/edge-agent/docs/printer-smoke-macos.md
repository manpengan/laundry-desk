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

上面的固定载荷仅用于诊断，不可作为正式验收。正式验收必须使用待发布的 packaged `.app`
和同一真实订单快照，按以下顺序完成三个不同的 server 签名派发：

1. 保持打印机连接，原始打印成功；保存已上传设备签名回执的 `job_id`。
2. 断开实体打印机，再从失败/不确定任务发起一次 retry/reprint。该次回执必须已上传，结果为
   `failed` 或 `uncertain`，并且没有 `cups_job_id`；现场同时确认没有迟到或重复票据。
3. 重新连接同一队列，显式执行「补打一份」，保存成功回执的第三个 `job_id`，并确认只出一份。

三份回执必须来自同一 queue、同一 snapshot，receipt sequence 严格递增；两次成功提交还必须
具有不同的 CUPS job id。然后输入真实机型、连接方式和待验收 `.app` 的 canonical 绝对路径：

```bash
pnpm --filter @laundry/edge-agent printer-acceptance:mac -- \
  --original-job-id <original-succeeded-uuid> \
  --disconnect-job-id <disconnect-failed-or-uncertain-uuid> \
  --reprint-job-id <explicit-reprint-succeeded-uuid> \
  --printer-model "Xprinter XP-58IIH" \
  --connection usb \
  --app-path "/Applications/laundry-desk V2.app"
```

`--connection` 仅允许 `usb`、`ethernet`、`wifi`。CLI 会自行以 no-follow、单链接、大小上限和
读取前后 TOCTOU 重检计算 `Contents/Resources/app.asar` 及
`Contents/Resources/spa/manifest.json` 的 SHA-256；不接受操作员提供的 hash。

七项（中文、金额、走纸、切/撕、条码、断连不重复、显式补打仅一份）全部确认后，才会在
当前用户的 Application Support 私有目录 create-only 写入 `0600` schema v3 JSON。记录保存
真实 snapshot SHA-256、两份 packaged artifact hash，以及三次派发的 result、receipt sequence
和 job/队列/CUPS job 指纹；不保存原始 job、队列、CUPS job、客户数据或照片。参数重复、未知
或缺失，自动化/无 TTY，证据链任一约束不满足，或者 artifact 发生文件竞态时均不生成记录。
