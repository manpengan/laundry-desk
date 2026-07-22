# A7 评审单：OpenAPI 3.1 快照（contracts 投影）

> 主责：**Grok**（ADR-12）　落点：`packages/contracts/src/openapi/`  
> 前置：A1 注册表、A2 信封、A5 `AUTH_OPERATION_MATRIX`、A6 `M1_FIRST_WAVE_DEFINITIONS`  
> 状态：**✅ 已冻结**（合入 main；快照 `openapi/laundry-v2.openapi.json` + 契约测试）

## 1. 范围

| 资产 | 说明 |
| --- | --- |
| `src/openapi/build-document.ts` | 从 A6 定义 + A5 auth 矩阵确定性构建 OpenAPI **3.1.0** |
| `scripts/generate-openapi.ts` | 写 `openapi/laundry-v2.openapi.json`；无时间戳/主机路径 |
| `openapi/laundry-v2.openapi.json` | 已提交快照（契约测试真源） |
| `test/openapi-snapshot.test.ts` | 快照 diff 必失败；覆盖 auth 路径、bus 路径、信封组件 |

### 投影规则

1. **Auth HTTP**：唯一源 `AUTH_OPERATION_MATRIX`（login / refresh / logout / pin_challenge / pin_verify）  
   - 路径保持矩阵字面值（如 `/api/v2/auth/login`）  
   - request/response schema id 与矩阵一致  
2. **Bus 命令/查询**：源 `M1_FIRST_WAVE_DEFINITIONS`  
   - `POST /v1/commands/{name}`（identity.\* / platform.\* 命令）  
   - `POST /v1/queries/{name}`（platform.\* 查询）  
3. **统一错误信封**：`CommandError` / `CommandFailureResponse` / `CommandResponse`（A2）  
4. **Zod → JSON Schema**：Zod **4.4.3** 原生 `z.toJSONSchema(..., { target: "openapi-3.1" })`  
   - 未引入 `@asteasolutions/zod-to-openapi`（避免额外依赖；peer 虽已支持 zod 4，轻量手写更稳）

### 确定性

- 路径键、组件 schema 键、嵌套对象键均 `localeCompare` 排序  
- `info.version` 固定 `0.1.0`；文档无 `generatedAt` / 时间戳  
- 连续两次 `generate:openapi` 零 diff

## 2. 通过标准

- [x] `openapi` 字段为 `3.1.0`
- [x] 5 条 auth 路径 + 6 命令 + 3 查询 bus 路径
- [x] 统一失败信封 `$ref` 出现在响应
- [x] 快照测试：生成结果 === 提交文件
- [x] `pnpm --filter @laundry/contracts typecheck && test && lint` 绿
- [x] 单文件 ≤400 行（`build-document.ts`）

## 3. 非范围

- openapi-typescript / 前端生成类型脚本（可在 E1/E3 消费快照后追加）  
- C6/C8 运行时 handler、cookie 签发实现  
- Edge 桥协议 OpenAPI（A4 另轨；本快照仅 browser/bus 面）

## 4. 命令

```bash
pnpm --filter @laundry/contracts generate:openapi
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts lint
```
