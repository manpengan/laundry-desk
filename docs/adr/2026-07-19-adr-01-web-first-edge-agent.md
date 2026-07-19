# ADR-01: Web-first + Local Edge Agent

- 日期：2026-07-19　状态：**Accepted**（2026-07-19 定点复核通过，批量签署）　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §2、§10

## 决策

1. 主形态为 Web-first SPA + 云端 API；桌面端不再承载业务，降级/升级为 **Local Edge Agent**（Electron 常驻，托盘 + 自动更新，协议独立可换 Tauri）。
2. Edge Agent 职责：加密 SQLite（SQLCipher）离线交易队列与审计暂存；**签名 + 版本化打印模板的本地渲染**（在线离线一致，server 渲染仅用于 Web 预览）；三类打印执行与状态回传；扫码监听；钱箱/打印走**一次性授权票据**；离线票号段持有与回放。
3. **签名方向（二轮修订；浏览器永不持设备私钥）**：Server→Edge 用**服务端签发的能力票据**（绑定 action/job/staff/device/origin/exp/nonce，浏览器仅透传）；Edge→Server 用设备私钥签**执行回执**；本地通道 `wss://127.0.0.1` + Origin 白名单 + 每消息 `{nonce, seq, exp}` 防重放；配对 = 60 秒一次性码 + 设备密钥对（私钥仅存本机 OS 凭据区）。
4. **离线授权 = offline grant**：服务端预签发的短时（默认 12h）、设备绑定、含权限版本号与命令白名单的授权；无 grant 离线只能打印已渲染任务。
5. **队列加密职责分离**：SQLCipher 随机 DB DEK，由 OS 凭据区（DPAPI/Keychain）KEK 包装，**不从设备签名私钥派生**。设备解绑（三审修正语义）：**服务端吊销原子**（票据/grant/lease/号段），**本地擦除 best-effort**（离线设备由租约短时效兜底，重连第一动作强制擦除+重配对）。
6. Edge 无业务逻辑：校验语义全部在 server 命令总线，Edge 只是受约束的执行与暂存端。
7. 浏览器 IndexedDB 仅缓存 UI/字典只读数据，不承担交易、审计、冲突处理。
8. **桌面为主、Web 次之（三审后用户裁定）**：桌面壳是主要交付形态；**断网冷启动**——安装包内置**签名的 last-known-good SPA 静态资产**，经自定义 `app://` 协议加载本地 UI（在线调云端 API，断网进本地离线工作台）；浏览器版与壳共用 React/contracts，**不复制业务代码**；前期开发以本地 web 服务（单机模式）做测试适配。
9. **Electron 安全基线**（官方要求）：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、最小 preload（白名单 IPC + sender 校验）、禁任意导航/新窗口/外链、权限默认拒绝。
10. 每里程碑含桌面交付物，与服务端同灰度发版；升级状态机与 LTS 见 [ADR-08](2026-07-19-adr-08-release-desktop-upgrade-lts-support.md)。

## 理由

- 打印机/扫码枪/钱箱/秤必须本地驱动；但 draft1 的"server 渲染字节流 + 断网照常打印"自相矛盾（二审发现）——签名模板本地渲染同时解决一致性与离线。
- WebSocket 需显式 Origin 校验与逐消息授权（OWASP），127.0.0.1 不等于可信。

## 否决的备选

- 纯桌面应用（重走顺科老路，云/多端能力受限）。
- 纯 Web 无桥（小票/水洗唛/不干胶无法可靠打印）。
- 浏览器承担离线队列（敏感状态在不可控存储；二审否决）。

## 后果

- Edge v0（配对/模板/小票/队列骨架）进 V2-M1；协议先冻结于 contracts 包。
- 离线能力仅在配对终端可用；离线高危操作仅 Primary Edge（ADR-04）。
- M0 必测：Windows Chrome/Edge 对 127.0.0.1 WSS 的证书信任、Chrome Local Network Access 权限、防火墙行为——结果决定本地通道最终形态。
