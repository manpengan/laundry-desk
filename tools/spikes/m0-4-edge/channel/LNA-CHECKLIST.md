# Chrome Local Network Access（LNA）演练

## 背景

Chrome 收紧「**公网源** 访问私网/本机」能力（Local Network Access）。  
**loopback 页 → loopback WSS 不会触发 LNA**——旧 L2（`127.0.0.1:5500` → `127.0.0.1:17443`）**结论无效**。

| 场景 | 源地址空间 | 是否测 LNA |
|---|---|---|
| L1 | loopback → loopback | 仅基线连通，**非** LNA |
| L2 | **public HTTPS** → loopback WSS | **唯一有效 LNA 证据** |
| L3 | app:// 壳内 | 桌面主路径对照 |

柜台含义：云端 SPA + 本机 Edge 才会撞 LNA；壳内 `app://` 主路径影响小。

## 前置

```powershell
cd tools\spikes\m0-4-edge
npm install
npm run cert
npm run wss
# 确认 https://127.0.0.1:17443/client 本机可开（L1）
```

探针页：`channel/browser-client.html`（与 `/client` 同源副本逻辑一致）。  
公网探针可用同一文件，**必须由公网 HTTPS 源托管**（不可再是 127.0.0.1）。

## L1 — 基线（对照，不算 LNA 通过）

1. Chrome 打开 `https://127.0.0.1:17443/client`（先处理证书信任，见 CERT-TRUST）  
2. 连接 `wss://127.0.0.1:17443` → 应 open + ping ack  
3. 记录：无 LNA 弹窗是 **预期**（同源/同 loopback）

## L2 — 真实公网源（必修）

任选 **一条** 可复现路径：

### 路径 A · 公网静态托管（推荐）

1. 将 `channel/browser-client.html` 发布到 **公网 HTTPS**（任选）：
   - Cloudflare Pages / Surge / GitHub Pages  
   - 或推送后用 jsDelivr（示例，以实际 commit 为准）：  
     `https://cdn.jsdelivr.net/gh/manpengan/laundry-desk@grok/m0-spikes/tools/spikes/m0-4-edge/channel/browser-client.html`
2. 用 Chrome **无痕**打开该 **https://…** URL（地址栏不得是 127.0.0.1）  
3. URL 框保持 `wss://127.0.0.1:17443`，点「连接」  
4. 记录：是否弹出 **Local network access / 本地网络** 权限；默认允许还是拒绝；允许后是否 open  

### 路径 B · Chrome ip-address-space-overrides（无公网时的 lab 替代）

> 仅当无法托管公网页时使用；须在记录表注明 **flag 模拟 public**。

1. Chrome 打开 `chrome://flags/#ip-address-space-overrides`  
2. 配置将「探针页的来源」标为 public（语法随 Chromium 版本变化，以 flag 说明为准）。  
   常见实验做法：用第二个非 loopback 主机名指向本机静态页，并在 overrides 里标 public。  
3. 或使用命令行（版本相关，失败则退回路径 A）：  
   `chrome.exe --ip-address-space-overrides="127.0.0.1:17443=loopback"`  
   **注意**：overrides 不能替代「页面本身是 public」——若页面仍是 loopback，LNA 仍不触发。  
4. **可靠 lab 组合**：`npx serve` 绑到 **局域网 IP**（如 `http://192.168.x.x:5500`）托管 `browser-client.html`，从另一台机器或同一机用该 **非 loopback origin** 打开，再连 `wss://127.0.0.1:17443`。私网→loopback 在部分 Chrome 版本也会走 LNA/PNA 检查，优于 loopback→loopback。  

**判定有效 L2 的最低标准**：页面 origin 的 host **不是** `127.0.0.1` / `localhost` / `[::1]`。

## 其它记录

5. DevTools → Console / Network：失败码、权限文案  
6. 页面「环境探测」：`permission:local-network-access` 查询结果  
7. `chrome://settings/content` 中 Local network 相关项（若有）

## 记录表

| 场景 | 页面 origin（完整） | 是否弹 LNA | 默认结果 | 允许后 | Chrome 版本 |
|---|---|---|---|---|---|
| L1 loopback 页 | `https://127.0.0.1:17443` | 通常否 |  |  |  |
| L2 公网 HTTPS 页 | `https://…`（非 loopback） |  |  |  |  |
| L2-alt 局域网 IP 页 | `http://192.168.…` |  |  |  |  |
| L3 app:// 壳 | `app://local/...` |  |  |  |  |

## 判定

- L2 默认拦截且权限 UX 差 → 浏览器版打印/硬件应 **降级**（壳内通道为主，或下载任务）  
- 桌面为主策略下，**主路径 = 壳内**；浏览器 WSS 为增强  
- **仅有 L1 成功 ≠ LNA 已验证**（写 findings 时禁止把 L1 写成 LNA 通过）
