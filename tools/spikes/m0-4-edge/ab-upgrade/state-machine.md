# Edge 升级状态机（spike 摘要 · ADR-08 / §13.5）

```text
                    ┌─────────────┐
                    │   ACTIVE    │  主槽运行
                    └──────┬──────┘
           queue empty + snapshot + no new Primary lease
                           │
                           v
                    ┌─────────────┐
                    │ INSTALL_B   │  备槽写入新版本
                    └──────┬──────┘
                           │
              health check (hw + db + handshake)
                     /            \
                   pass            fail
                   /                \
                  v                  v
           SWITCH_ACTIVE        REVERT_STANDBY
           (B becomes A)        (保持原主槽)
                  │
                  v
           optional migrate local schema (expand→migrate→contract)
                  │
        rollback requested?
           /            \
   matrix says OK     matrix says NO
   old reads schema   (contract done / anti-rollback)
        │                    │
        v                    v
   ROLLBACK_SLOT       RECOVERY_MODE
   (切回旧槽)          只打印+只读，等待前滚
```

## 硬规则（验收）

1. 队列未清空 → **不得安装**  
2. 升级窗口内 **不签发新 Primary lease**（本 spike 用 flag 模拟）  
3. 升级前创建本地库快照；失败可 `restore-snapshot`  
4. 健康检查失败 → **自动回原槽**（不碰数据契约）  
5. 回滚仅当支持矩阵 `rollbackReadsSchema=true`；否则 **恢复模式**，禁止盲目降级  
6. 低于 `minSecureVersion` 的包拒绝安装与回滚（anti-rollback）  
