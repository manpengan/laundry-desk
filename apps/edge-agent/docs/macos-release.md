# macOS 签名、公证与升级清单

本入口只用于正式分发产物；日常 `package:mac` 和 `local:acceptance` 仍生成未签名的本地
测试 `.app`，两条链路互不冒充。

## 前置

1. 在登录钥匙串或专用钥匙串中安装 `Developer ID Application` 证书。
2. 使用 `xcrun notarytool store-credentials` 创建钥匙串 profile；认证 secret 只进入
   Keychain，不写仓库、环境值或命令历史。
3. 在仓库外生成独立 Ed25519 更新密钥。私钥权限必须是 `0600`，公钥可以分发：

```bash
umask 077
openssl genpkey -algorithm ED25519 -out "/absolute/private/update-private.pem"
openssl pkey -in "/absolute/private/update-private.pem" \
  -pubout -out "/absolute/public/update-public.pem"
```

4. 把 `release-policy.example.json` 复制到仓库外并逐次发布复核。`rollback` 为 `null`
   表示本版本没有签名允许的回退目标；不得为方便测试随意填写。
5. 把 `update-config.example.json` 复制到仓库外并准备严格 `update-config.json`。正式配置
   必须 `enabled: true`，并包含固定、
   无凭据、无 query/fragment 的 HTTPS manifest URL 及 `beta|stable|lts` channel；运行时只读
   bundle 内该配置，不依赖 Finder 启动时通常不存在的宿主环境变量。执行前必须替换
   `updates.example`；入口拒绝示例域名，并要求 channel 与签名 release policy 一致。

## 执行

只传非 secret 的身份名称、Keychain/profile 名和仓库外文件路径：

```bash
export CSC_NAME='Developer ID Application: Example Company (TEAMID1234)'
export APPLE_KEYCHAIN='/absolute/path/release.keychain-db'
export APPLE_KEYCHAIN_PROFILE='laundry-notary'
export LAUNDRY_UPDATE_PRIVATE_KEY_FILE='/absolute/private/update-private.pem'
export LAUNDRY_UPDATE_PUBLIC_KEY_FILE='/absolute/public/update-public.pem'
export LAUNDRY_RELEASE_POLICY_FILE='/absolute/policy/release-policy.json'
export LAUNDRY_UPDATE_CONFIG_FILE='/absolute/policy/update-config.json'

pnpm --filter @laundry/edge-agent release:mac
```

入口会依次：

1. 核对精确 Developer ID 身份，并用 `notarytool history` 预检 profile；
2. 核对更新公私钥匹配；私钥路径只交给最终清单签名进程，构建、公证及依赖脚本均不可见；
3. 把严格 update config 与公钥一同放进签名 bundle；开发包只携带明确 disabled 的独立
   测试配置；
4. 强制 arm64+x86_64 universal、hardened runtime、Developer ID 签名、公证、DMG + ZIP；
5. 递归检查 App、ZIP 解包 App 与 DMG 挂载 App 的全部 Mach-O 均为双架构，并绑定
   bundle ID、TeamIdentifier、CDHash 与 designated requirement；随后执行 `codesign`、
   Gatekeeper 和 stapled ticket 校验；
6. 为精确 DMG/ZIP 大小与 SHA-256 生成 Ed25519 签名的
   `release/latest-laundry-v2.json`；全部步骤只写唯一临时目录，成功后才原子发布为
   `release/`，失败不会留下可误发的半成品。正式执行前该目录必须不存在。

任一凭据、制品、摘要、版本窗口或回退边界不满足时均失败关闭。发布清单签名覆盖渠道、
版本、最低安全版本、最低可升级版本、contracts major、本地 schema、制品摘要以及可选
回退目标；运行端还必须保留本机已经接受的最低安全版本，不能被新清单调低。

## 外部证据边界

- 没有真实 Developer ID、Apple 公证响应与 Gatekeeper 通过记录，不能宣称正式 macOS
  分发已验收。
- `latest-laundry-v2.json` 证明升级制品与策略来源；它不替代 A/B 槽健康检查、离线队列
  排空、本地快照和支持矩阵回退判定。
- ZIP 保留给升级分发，DMG 给人工安装；两者必须来自同一次版本构建。
