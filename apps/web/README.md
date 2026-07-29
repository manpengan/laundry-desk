# `@laundry/web` — 通用 V2 柜台 SPA

同一套 React UI 运行在本地浏览器和 macOS Electron 壳，通过宿主注入的命名端口访问
认证、命令、查询、照片与健康状态。

**已交付**：

- 登录页（org_code / store_code / username / password）
- Access session **仅内存**（React state），不写 localStorage / sessionStorage
- 顶栏「切换员工」→ PIN quick-switch dialog（`purpose: quick_switch`）
- 连接状态条（SyncStatusBar）在已登录壳内展示
- 开单、挂单、撤销、订单详情、取衣与整数分权威计价
- **统一取衣检索**：票号、取件码、衣物条码、手机号或姓名前缀 → 受限的 `order.lookup` 候选集
- **独立收款 / 补缴**：付款方式与备注 → `payment.collect` / `payment.repay` 的只追加账本流水
- 今日统计与历史营业日交班
- 订单详情衣物照片选择、受限上传、持久化数量和可重试加载错误
- 浏览器 `PhotoPort` 与 Electron 专用照片 IPC；渲染进程不能选择 URL、Header 或设备身份
- HTTP / IPC 成功结果使用严格照片元数据契约，拒绝私有存储 key 或非法 ID

**未做**：照片缩略图/删除、完整价目字典 UI、A7 OpenAPI 生成客户端。

## 使用

宿主入口应使用 `createBrowserPorts` 或 Electron preload 提供的固定
`window.laundryDesktop` bridge。不要向渲染进程开放通用 `fetch` / `ipcRenderer.invoke`。

本地运行与凭据准备见[本地联调指南](../../docs/local-web-server.md)。

## 开发

```bash
pnpm --filter @laundry/web test
pnpm --filter @laundry/web typecheck
pnpm local:web:e2e
```
