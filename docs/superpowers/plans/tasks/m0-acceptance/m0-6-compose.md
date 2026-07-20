# M0-6 验收单：本地单机模式（compose）

> 主责：**Gemini**　验收：Claude　产出：`tools/spikes/m0-6-compose/`（验收通过后转正为 `tools/compose/`）
> 依据：实施计划 §1.1、任务书 gemini §2、架构 §2/§13.3（桌面为主，前期以本地 web 服务做测试适配）、ADR-02（角色口径）
> 公共规则见 [README](README.md)。**本项是唯一验收后转正的 spike——质量按"全队要用"的标准做。**

## 1. 目标

给全队一个一键可起、可复现的本地单机环境（server + PG），作为桌面为主策略下所有后续开发与测试的统一底座；同时把 ADR-02 的角色口径（owner / `laundry_app`）在环境层固化。

## 2. 步骤

1. `docker compose`：`postgres:16` + server 占位（最小 mock server，带 healthcheck）+（mock）Edge 占位；端口、卷、依赖顺序（`depends_on` + healthcheck 条件）。
2. 初始化 SQL（挂载执行）：owner 角色（表所有者/迁移用）与 `laundry_app`（**非所有者、NOBYPASSRLS**）分离；基础库/schema。
3. 冒烟脚本：等待 healthcheck 全绿 → 对 mock server 走一遍 **假开单 → 打印(mock) → 取衣** 的 HTTP/DB 往返。语义澄清（本单裁定，消除任务书歧义）：**mock 指验证"环境连通 + 角色配置 + 三步往返可观测"，不是业务逻辑实现**——M0 不写生产代码，开单/取衣可以是对 mock 表的最小读写。
4. 幂等与清理：`docker compose down -v` 后重跑全绿；README 写明端口与默认凭据（弱凭据仅限本地并注明）。
5. 与 M0-1 对齐：PG 版本与角色初始化与 M0-1 一致，M0-1 可直接复用本环境。

## 3. 通过标准（逐条判定）

- [ ] 全新 clone 后 `docker compose up -d` 一键起，healthcheck 全绿（README 记录实测冷启动耗时）。
- [ ] 冒烟脚本 exit 0：假开单 → 打印(mock) → 取衣 三步往返各有可观测输出（日志或查询结果）。
- [ ] `laundry_app` 能以非 owner、NOBYPASSRLS 身份连接；owner 与应用角色分离在初始化 SQL 中固化。
- [ ] `down -v` → `up` 重跑全绿（幂等可复现）。
- [ ] M0-1 声明可复用本环境（Codex 确认或 M0-1 README 引用之）。
- [ ] README 记录已验证平台清单（至少主开发平台跑通；未验证平台如实注明，不强制双平台）。
- [ ] 无任何真实凭据/密钥入库；compose 与 SQL 里只有本地弱凭据且有注释声明。

## 4. 证据格式

- `tools/spikes/m0-6-compose/`：`compose.yml`、初始化 SQL、冒烟脚本本体（三者即交付物主体）。
- `README.md`：前置依赖（Docker 版本）、一键命令、端口/凭据表、平台清单、耗时。
- `evidence/`：一次完整 `up` 的日志摘要 + 冒烟脚本输出全文。
- findings `## M0-6` 小节：结论行 + 环境参数表 + 坑（如 Windows 卷挂载/行尾问题）。

## 5. 不通过 / 需改设计

compose 无法在主开发平台一键复现（需手工步骤补救）= 不通过，修到一键为止。若 PG 16 容器化在目标平台有硬障碍 → 报「需改设计」（影响架构 §2 部署形态），Claude 起草 ADR。
