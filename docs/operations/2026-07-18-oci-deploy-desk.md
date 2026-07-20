# laundry-desk 公网部署运维手册（desk.manpengan.xyz）

- 部署日期：2026-07-18
- 节点：OCI 春川 `oci-node-168`（168.107.27.134，Ubuntu 24.04 aarch64）
- 访问地址：<https://desk.manpengan.xyz>
- **不依赖 NAS**：全链路在 OCI 本机，NAS 隧道故障不影响本服务

## 链路

```
浏览器 → HTTPS 443（HAProxy，SNI=desk.manpengan.xyz）
       → 127.0.0.1:8446（nginx，TLS 终止 + Basic Auth）
       → 127.0.0.1:8620（node，laundry-desk.service）
       → SQLite /opt/laundry-desk/data/laundry.db
```

其余域名（gitea / kb / packet 等）的 SNI 分流规则未改动。

## 服务器组件

| 项 | 位置 |
| --- | --- |
| 应用目录 | `/opt/laundry-desk`（属主 `www-data`） |
| 数据目录 | `/opt/laundry-desk/data`（SQLite + photos + backups） |
| systemd | `/etc/systemd/system/laundry-desk.service`（enabled，Restart=always） |
| nginx | `/etc/nginx/conf.d/20-laundry-desk.conf`（:80 跳转 + :8446 TLS） |
| HAProxy | `/etc/haproxy/haproxy.cfg` 中 `sni_desk` → `nginx_desk_https` |
| 证书 | `/etc/letsencrypt/live/desk.manpengan.xyz/`（certbot 自动续期，2026-10-16 到期） |
| 访问凭证 | 服务器 `/root/desk-auth.txt`(600)；Mac `~/.laundry-desk-web-auth.txt`(600) |

**凭证说明**：M4 登录鉴权上线前，用 nginx Basic Auth（用户 `hongfa`）作为唯一访问控制。口令仅存于上述两个 600 文件，不入库、不进仓库。

## 发布新版本

在 Mac 的构建目录（当前为 scratchpad 隔离副本，后续可切回真实项目）：

```bash
npm run build:web
rsync -az --delete out/ oci-node-168:/opt/laundry-desk/out/
rsync -az package.json package-lock.json oci-node-168:/opt/laundry-desk/
ssh oci-node-168 'cd /opt/laundry-desk \
  && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm rebuild better-sqlite3 \
  && chown -R www-data:www-data /opt/laundry-desk \
  && systemctl restart laundry-desk && systemctl is-active laundry-desk'
```

依赖未变更时可省略 `npm ci` / `rebuild` 两步。

## 健康检查

```bash
ssh oci-node-168 'systemctl is-active laundry-desk; ss -lntp | grep 8620'
curl -so /dev/null -w "%{http_code}\n" https://desk.manpengan.xyz/          # 期望 401
curl -su "$(cat ~/.laundry-desk-web-auth.txt)" -so /dev/null -w "%{http_code}\n" https://desk.manpengan.xyz/  # 期望 200
ssh oci-node-168 'journalctl -u laundry-desk -n 50 --no-pager'
```

## 备份

应用内置 `node-cron` 每日 03:00 备份至 `/opt/laundry-desk/data/backups/`，滚动保留 30 份；设置页可手动触发。异地副本尚未配置（见下）。

## 已知限制

1. **无用户登录**：仅 Basic Auth 单账号，无操作人审计（`staffId` 为空）。M4 完成后应替换。
2. **桌面专属功能不可用**：Excel 导入导出、58mm 热敏打印依赖 Electron 对话框/驱动，web 端未注册这两个 channel，点击返回错误信封；需在柜台机跑桌面版。
3. **备份仅在本机**：`/data` 随实例存亡，建议后续加 rclone/rsync 异地同步。
4. **单实例无水平扩展**：SQLite 本地文件，符合单店场景。

## 回滚

```bash
ssh oci-node-168 'systemctl stop laundry-desk'
# 移除 HAProxy 中 sni_desk / nginx_desk_https 两段（有 .bak.<时间戳> 备份可还原）
ssh oci-node-168 'sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo systemctl reload haproxy'
ssh oci-node-168 'sudo rm /etc/nginx/conf.d/20-laundry-desk.conf && sudo nginx -t && sudo systemctl reload nginx'
```
