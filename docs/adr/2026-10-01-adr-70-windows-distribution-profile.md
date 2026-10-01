# ADR-70：Windows development 发行 profile 与构建绑定

- 日期：2026-10-01
- 状态：**Accepted**（会话授权后续软件切片 1–5 全部推进）
- 决策者：manpengan；Codex 负责实现与验证
- 前序：[ADR-66](2026-08-29-adr-66-windows-hongfa-pilot.md)、
  [ADR-67](2026-08-30-adr-67-windows-native-local-runtime.md)
- 影响：活动 V2 Windows 发行身份、构建资源与检查器；不新增业务 Command/Query 或迁移

## 背景

ADR-66 允许宏发作为通用 V2 的首个受控发行 profile，但此前 Windows 构建只有固定通用显示名、
应用标识和安装器名称。不能为品牌定制修改服务端组织、门店、计价、权限或审计，也不能把任意
服务地址或私密配置放入可分发包。

## 决策

### 1. 发行身份仅接受两个固定 development profile

固定资源位于 `apps/edge-agent/resources/windows-profiles`，只接受 `generic` 与 `hongfa`。
schema 字段严格为版本、`development_only` assurance、profile 标识、显示名、图标、固定服务
origin、安装应用标识和设备类型。代码 allowlist 与资源内容共同确认各 profile，不接受外部 profile
文件、任意品牌字符串、未知字段或运行时覆盖。

| 字段        | generic               | hongfa                     |
| ----------- | --------------------- | -------------------------- |
| 显示名      | laundry-desk V2       | 宏发洗衣 V2（开发版）      |
| appId       | com.laundry-desk.v2   | com.laundry-desk.v2.hongfa |
| 图标        | build/icon.ico        | build/icon.ico             |
| 服务 origin | http://127.0.0.1:8787 | http://127.0.0.1:8787      |
| 设备类型    | windows-spooler-raw   | windows-spooler-raw        |

设备字段声明当前发行的软件类型范围，不开启未经验证的设备能力，也不证明实体出纸。宏发仍使用
现有通用图标；新品牌图标须在后续经审查的固定资源与清单中登记，不接受任意路径或 URL。

profile 不允许密码、PIN、token、私钥、数据库 URL、顾客信息、组织/门店标识或计价/权限参数。
不得修改 `LOCAL_PROFILE` 或通过 `hongfa` 分支改变核心业务。

### 2. 构建与包检查绑定 profile 字节和源码身份

输入仅允许有界、canonical UTF-8 JSON；重复键、未知字段、链接、硬链接、符号链接祖先和超限文件
失败关闭。构建阶段返回已验证的 packaging overrides，并把 `profile.json` 与 `binding.json` 放入
专用 staging 目录。binding 记录 development assurance、profile 标识、profile 字节 SHA-256 和
构建预期源码 SHA；清洁源码检查继续由既有 Windows 构建门禁完成，binding 不自称已通过该检查。

包内 `resources/distribution-profile` 只能含这两个普通唯一文件。检查器核对调用方期待的 profile、
源码 SHA 和实际 profile 摘要；该源码 SHA 须与既有 helper provenance 一致。profile 摘要只是完整性
绑定，不替代发布者签名、clean-source 门禁或安装授权。

通用 profile 保持现有 appId、EXE 和安装器名称；宏发使用独立 appId、显示名与安装器名称。
已有 staging 仅在内容与本次身份完全一致时复用；未知文件或身份冲突保留并拒绝，不自动清理。

### 3. 安装身份不改变 Runtime 与生产准入权威

两种发行均连接 ADR-67 的同一固定 loopback Runtime；Electron 不获得数据库生命周期所有权。
不同 appId 仅区分 Windows 发行安装身份，不证明租户、数据库、密钥或生产环境隔离。
当前 companion 仍为每用户单实例，不能据品牌安装标识推导出两个可并行的 Runtime。

ADR-65 的独立 production-candidate、离机恢复、告警、容量与数据责任，以及 ADR-66 的签名、
三类实体打印、操作员、迁移授权和试点停止条件继续单独关闭。本片不接入真实宏发数据，不创建
生产 origin，不授予上线或真实记账许可。

## 验收与后果

测试覆盖两种固定身份、canonical/编码/大小、未知或秘密字段、origin/图标/设备/应用标识篡改、
源码与 profile 摘要脱离、包内额外文件、链接和已有 staging 保留。构建接入及 packaged inspector
须继续复用这些验证函数，不能只把资源复制进包便宣布品牌发行完整。

本片可先进行 development-only 合成数据构建与安装测试；正式宏发发行策略或服务拓扑发生变化时，
需另行裁决并更新 profile allowlist 和相关验收记录。
