# SPA bundle 保留策略

> 记录于 2026-07-28。回答一个会被反复提出的问题：
> `apps/edge-agent/resources/spa/bundles/` 为什么只增不减，是不是漏接了剪枝。

## 结论：不是漏接

分两层，各自已经有归属：

| 层             | 谁负责                             | 是否有界 |
| -------------- | ---------------------------------- | -------- |
| **打包产物**   | `scripts/prune-packaged-spa.mjs`   | ✅ 有界  |
| **仓库工作树** | `scripts/sync-spa.mjs`（有意保留） | ❌ 无界  |

可随时执行只读计划核对当前体积与“若进入打包目录会删除哪些 bundle”；该命令不修改工作树：

```bash
pnpm --filter @laundry/edge-agent spa:retention:plan
```

**打包侧已经有界。** `electron-builder.yml` 把 `prune-packaged-spa.mjs` 挂在
`afterPack`，装包时只保留 manifest 指向的活动 bundle。仓库里的历史 bundle
**不会进入用户拿到的 .app / .exe**，安装包体积不受影响。
`scripts/hash-app.test.mjs` 断言了这条 `afterPack` 配置存在。

**仓库侧的保留是刻意的。** 发布流程要求崩溃安全：新 bundle 提交时，可能仍有
运行中的壳在读上一个 bundle；在暂存与指针 rename 之间被 SIGKILL，也必须让旧
版本保持可读（`sync-spa.test.mjs` 有对应用例）。目前没有任何机制追踪活跃读者，
所以 `cleanupAfterCommit` 只删除**损坏**的 bundle（目录名与 manifest 哈希不符），
保留全部合法 bundle。配套用例的名字就写明了解除条件：

> `syncSpa retains valid immutable bundle history until reader-aware pruning exists`

## 想动它之前要知道的

- bundle 大小随功能和拆包策略变化，不能再按早期约 340KB 估算。2026-08-13 的只读计划为
  48 个 bundle、工作树约 32MiB，当前活动 bundle 约 1.3MiB；后续应以上述命令实时结果为准。
- **git 永久保留所有已提交 blob**。事后删除历史 bundle 只能减小未来 checkout 体积，
  **不会重写既有 Git 历史**；仓库对象体积也应以 `git count-objects -vH` 实测，不沿用旧快照。
- **按「保留最近 N 个」收敛会破坏上面的崩溃安全不变量**，除非先落地读者感知
  （reader-aware）剪枝。

## 真正的可选改动

如果确实要收敛工作树，按代价从低到高：

1. **少提交**：bundle 是 `apps/web` 的构建产物，只在需要更新 Electron 壳内
   资产时才回灌，不必每次 web 改动都提交。
2. **读者感知剪枝**：给运行中的壳加 bundle 租约/引用登记，`sync-spa` 据此安全
   回收无人引用的旧 bundle。这是解除上述用例约束的正解，也是工作量最大的。
3. **不再入库**：改为构建期生成，不进 git。属于架构裁决，会影响完整性 manifest
   与打包链路，需要 ADR。

在 1/2/3 落地之前，**当前行为是正确的，不要直接加剪枝**。
