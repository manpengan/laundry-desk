# hk-vps 云测试环境运维手册（ADR-36）

- 环境：**开发测试**，允许随时丢弃，不承载真实顾客 PII
- 地址：<https://desk.manpengan.xyz>
- 主机：SSH alias `hk-vps`（实际地址和密钥由操作者的 SSH 配置管理）
- 裁决：[ADR-36](../adr/2026-08-09-adr-36-cloud-test-environment.md)

## 固定拓扑

```text
browser → Caddy :443 → 127.0.0.1:8787 Fastify
                              ↓
                     PostgreSQL 16 localhost:5432
```

| 项         | 固定位置/身份                                                         |
| ---------- | --------------------------------------------------------------------- |
| 应用树     | `/opt/laundry-desk`，`root:root`，服务只读                            |
| Node       | `/opt/nodejs/bin/node`（Node 22）                                     |
| systemd    | `/etc/systemd/system/laundry-desk.service`，以 `laundry:laundry` 运行 |
| 环境与密钥 | `/etc/laundry-desk/server.env`，`0600`，只在 VPS 生成和保存           |
| PostgreSQL | 裸机 PostgreSQL 16，只监听 `localhost`                                |
| 运行数据   | `/var/lib/laundry-desk`、`/var/lib/laundry`                           |
| Caddy      | `/etc/caddy/Caddyfile` 中 `desk.manpengan.xyz` 站点                   |
| 版本标识   | `/opt/laundry-desk/.laundry-release.json`                             |

禁止在部署命令、终端输出、Git、工件或支持包中复制 `server.env` 的值。部署只传源码，
不从服务器回传密码、token、cookie、数据库 URL 或私钥。

## 发布前检查

1. 本地工作树必须干净，候选必须是一个明确的 Git commit。
2. 运行 `pnpm workspace:check` 和真实 PostgreSQL 门禁。
3. 用 `hk-vps-ops` 的 helper 验证 SSH host fingerprint、身份和服务器健康。
4. 记录并验证两个站点，避免影响同机 KB：

```bash
curl --fail --silent --show-error https://desk.manpengan.xyz/health
curl --fail --silent --show-error https://kb.manpengan.xyz/health
```

## 从明确 Git SHA 部署

以下命令中的 `CANDIDATE_SHA` 必须来自干净工作树的 `git rev-parse HEAD`。服务器 staging
先复制当前完整运行树，再由 rsync 只替换仓库内容；`node_modules` 与构建产物在 staging
内重建，live 目录在构建期间不变。

```bash
export CANDIDATE_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
ssh hk-vps "cp -a /opt/laundry-desk /opt/laundry-desk.next-${CANDIDATE_SHA}"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.claude/' \
  --exclude='node_modules/' \
  --exclude='.turbo/' \
  --exclude='apps/*/dist/' \
  --exclude='apps/web/dist-spa/' \
  --exclude='packages/*/dist/' \
  ./ "hk-vps:/opt/laundry-desk.next-${CANDIDATE_SHA}/"
```

在 VPS 上以非 root 身份安装与构建，再恢复 root-owned 只读代码树：

```bash
ssh hk-vps "set -eu
  next=/opt/laundry-desk.next-${CANDIDATE_SHA}
  chown -R laundry:laundry \"\$next\"
  sudo -u laundry /opt/nodejs/bin/node --input-type=module -e '
    import { rm } from \"node:fs/promises\";
    import { join } from \"node:path\";
    const root = process.argv[1];
    const generated = [
      \".turbo\",
      \"apps/edge-agent/dist\",
      \"apps/server/dist\",
      \"apps/web/dist\",
      \"apps/web/dist-spa\",
      \"packages/config/dist\",
      \"packages/contracts/dist\",
      \"packages/db/dist\",
      \"packages/domain/dist\",
      \"packages/ui/dist\",
    ];
    for (const relative of generated) {
      await rm(join(root, relative), { recursive: true, force: true });
    }
  ' \"\$next\"
  cd \"\$next\"
  sudo -u laundry env CI=true PATH=/opt/nodejs/bin:/usr/bin:/bin \
    /opt/nodejs/bin/corepack pnpm install --frozen-lockfile
  sudo -u laundry env CI=true PATH=/opt/nodejs/bin:/usr/bin:/bin \
    /opt/nodejs/bin/corepack pnpm --filter @laundry/server... build
  sudo -u laundry env CI=true PATH=/opt/nodejs/bin:/usr/bin:/bin \
    /opt/nodejs/bin/corepack pnpm --filter @laundry/web... build
  chown -R root:root \"\$next\"
  chmod 0755 \"\$next\"
  test -z \"\$(find \"\$next\" -xdev \( -type f -o -type d \) -perm -0002 -print -quit)\"
  printf '{\"git_sha\":\"%s\",\"environment\":\"hk-vps-cloud-test\"}\n' '${CANDIDATE_SHA}' \
    > \"\$next/.laundry-release.json\"
  chmod 0644 \"\$next/.laundry-release.json\"
  caddy validate --config /etc/caddy/Caddyfile
"
```

迁移脚本从 VPS 私有 env 读取连接信息；不得把 URL 拼进 argv 或日志：

```bash
ssh hk-vps "set -eu
  set -a; . /etc/laundry-desk/server.env; set +a
  PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=laundry_v2 POSTGRES_USER=postgres \
    /opt/laundry-desk.next-${CANDIDATE_SHA}/tools/compose/migrate-v2.sh
"
```

最后短暂停服并以目录 rename 切换；旧树保留为唯一 rollback：

```bash
ssh hk-vps "set -eu
  old=\$(cat /opt/laundry-desk/.laundry-release.json 2>/dev/null | sha256sum | cut -c1-12 || echo legacy)
  systemctl stop laundry-desk.service
  mv /opt/laundry-desk /opt/laundry-desk.rollback-\$old
  mv /opt/laundry-desk.next-${CANDIDATE_SHA} /opt/laundry-desk
  systemctl start laundry-desk.service
  systemctl is-active --quiet laundry-desk.service
"
```

发布成功并稳定后只保留最近一份 rollback。删除前必须先验证它是
`/opt/laundry-desk.rollback-*` 的普通目录，不能用未解析变量或宽泛 glob 做递归删除。

## Smoke 与登录注意事项

登录请求的严格契约包含 `device_id` UUID：

```json
{
  "org_code": "local",
  "store_code": "main",
  "username": "<server-only>",
  "password": "<server-only>",
  "device_id": "<random UUID>"
}
```

缺少 `device_id` 与密码错误都按设计统一返回 401。Smoke 必须在 VPS 内读取现有 0600 env，
在进程内生成 JSON 并保存 token/cookie；只输出状态和固定断言，不能把请求体、密码、token、
cookie 或响应凭据打印到日志。

**排查 401 时先看服务端日志的 `reason_code`**，不要去猜、也不要为此放宽对外响应：

| `reason_code`           | 含义                                                                  | 处置                             |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `LOGIN_REQUEST_INVALID` | 请求没通过登录 schema，压根没到校验凭据这步（最常见是漏 `device_id`） | 修客户端请求体，不要动账号或密码 |
| `LOGIN_FAILED`          | 请求合法，凭据不匹配（org/store、用户名、密码、staff 未激活）         | 核对账号与密码                   |
| `LOGIN_RATE_LIMITED`    | 触发账号或 IP 限流                                                    | 等 `Retry-After`                 |

两者对外仍是同一个 401，响应体、状态码和响应头完全一致——这是有意的，外部不该知道请求
是否合法。差异只存在于运维自己的日志里。查看方式（`account_ref`/`ip_ref` 都是 HMAC 后的
不透明值，日志里没有明文账号、IP 或密码）：

```bash
journalctl -u laundry-desk --since "10 min ago" -o cat | grep -o '"reason_code":"[A-Z_]*"' | sort | uniq -c
```

发布完成的最低验收：

- loopback 与公网 `/health` ready；SPA 200、TLS 验证成功；
- 公网登录、refresh/CSRF cookie 轮换和 bearer 受保护查询成功；
- 一条只使用合成数据的 CSRF 写命令成功并可读回；
- PostgreSQL 只监听 127.0.0.1/::1；
- `kb.manpengan.xyz` 在部署前后都健康；
- `.laundry-release.json` 的 SHA 与已提交候选完全一致。

### ADR-36 完整公网验收入口

仓库提供 `pnpm cloud:adr36:acceptance`。它固定连接 `https://desk.manpengan.xyz`，只允许
合成数据，并会通过产品命令创建、回读和收口带唯一 run-id 的员工、价目、顾客、订单与会员
状态。不得把它指向生产数据，也不得与其他业务写入并发执行。

验收需要两位不同管理员的 8 个字段：

| 管理员 | 字段前缀                      | 必需字段                                      |
| ------ | ----------------------------- | --------------------------------------------- |
| 发起人 | `LAUNDRY_BOOTSTRAP_ADMIN_`    | `USERNAME`、`DISPLAY_NAME`、`PASSWORD`、`PIN` |
| 复核人 | `LAUNDRY_BOOTSTRAP_APPROVER_` | `USERNAME`、`DISPLAY_NAME`、`PASSWORD`、`PIN` |

每个字段可直接传值，或改用同名加 `_FILE` 的来源；两者同时设置会失败关闭。VPS 上应只使用
`_FILE`：路径必须是绝对路径、普通文件、权限精确 `0600`、单行且不得是符号链接。运行示例
只引用文件路径，不回显文件内容：

```bash
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME_FILE=/absolute/private/admin-username \
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME_FILE=/absolute/private/admin-display-name \
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE=/absolute/private/admin-password \
LAUNDRY_BOOTSTRAP_ADMIN_PIN_FILE=/absolute/private/admin-pin \
LAUNDRY_BOOTSTRAP_APPROVER_USERNAME_FILE=/absolute/private/approver-username \
LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME_FILE=/absolute/private/approver-display-name \
LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE=/absolute/private/approver-password \
LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE=/absolute/private/approver-pin \
pnpm cloud:adr36:acceptance
```

脚本只输出 run-id、旅程状态和稳定错误码，不输出凭据、Cookie、token、手机号或响应体。退出码
`0` 表示所有脚本内必验项通过，`1` 表示执行失败；在历史催取 fixture 尚未授权时，安全子集
通过仍会返回 `2` 和 `overall BLOCKED PARTIAL_ACCEPTANCE_ONLY`，不得改写为成功退出。

## 回滚

若迁移未开始，或迁移仍与旧代码兼容，可切回最近 rollback：

```bash
ssh hk-vps 'set -eu
  systemctl stop laundry-desk.service
  mv /opt/laundry-desk /opt/laundry-desk.failed-$(date -u +%Y%m%dT%H%M%SZ)
  mv /opt/laundry-desk.rollback-<verified-id> /opt/laundry-desk
  systemctl start laundry-desk.service
  systemctl is-active --quiet laundry-desk.service
'
```

数据库迁移不做自动 down。若新迁移不向后兼容，必须使用事前数据库恢复点或交付专门修复，
不能只切换旧代码后宣称回滚完成。

## 维护重启

`/var/run/reboot-required` 出现时，先验证两个站点并确认无构建/迁移进程；执行 `systemctl reboot`
后等待严格 key-only SSH 恢复，再核对 PostgreSQL、Caddy、laundry-desk、KB、端口、TLS、登录和
版本标识。不得因 desk 恢复就忽略同机 KB。
