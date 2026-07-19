# Chrome Local Network Access（LNA）演练

## 背景

Chrome 正在收紧「公网页访问私网/本机」的能力（Local Network Access / 原 Private Network Access）。  
柜台场景：

- **壳内 `app://`**：通常不经过公网源，LNA 影响较小  
- **浏览器连云端 SPA + 本机 Edge**：可能触发 LNA 权限提示  

## 步骤

1. 启动 `npm run wss`  
2. **场景 L1（本机同源）**：打开 `https://127.0.0.1:17443/client` 点连接  
3. **场景 L2（模拟公网页）**：用第二个静态源（可用 `npx serve` 起一个 `http://127.0.0.1:5500` 托管拷贝的 client，或临时改 host 映射）尝试 `new WebSocket('wss://127.0.0.1:17443')`  
4. 打开 `chrome://flags` / `chrome://settings/content` 搜索 Local network / 不安全内容  
5. DevTools → Console / Network 记录失败码与权限提示文案  
6. 在 client 页「环境探测」区记录 `permission:local-network-access` 查询结果  

## 记录表

| 场景 | 是否弹权限 | 默认结果 | 用户允许后 | Chrome 版本 |
|---|---|---|---|---|
| L1 127.0.0.1 页 → 127.0.0.1 WSS |  |  |  | |
| L2 其他 origin → 127.0.0.1 WSS |  |  |  | |
| app:// 壳内（冷启动演练包） |  |  |  | |

## 判定

- 若 L2 默认拦截且权限 UX 难懂 → **浏览器版必须降级策略**（仅在线 API，打印走「下载任务/桌面壳」）  
- 桌面为主策略下，**主路径应是壳内通道**，浏览器 WSS 为增强而非唯一  
