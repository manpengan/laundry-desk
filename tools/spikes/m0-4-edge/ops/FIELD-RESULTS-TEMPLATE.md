# M0-4 现场结果回传

## 环境

- 日期：
- Windows：
- Chrome：
- Edge 浏览器：
- Node：
- commit：

## 通道结论

| 项 | 结果 | 备注 |
|---|---|---|
| WSS 证书信任可行性 |  | |
| 推荐通道形态 A/B/C |  | 见 CERT-TRUST-CHECKLIST 判定 |
| Chrome LNA（**L2 公网 origin 原文**） |  | loopback→loopback 不算 |
| 防火墙 loopback |  | |
## 冷启动

| 项 | 结果 |
|---|---|
| app:// 加载 |  |
| 断网重启应用 |  |
| OS 断电冷启动 |  |
| 完整性失败可拦 |  |
| 安全基线九项 | 全通过 / 有缺口： |
| **录屏**路径（优先） |  |
## A/B 升级

| 剧本 | 结果 |
|---|---|
| health fail 不切槽 |  |
| health pass 切槽 |  |
| matrix 兼容可回滚 |  |
| matrix 不兼容 → 恢复模式 |  |
| 快照恢复 |  |
| anti-rollback |  |
| 裸 rollback（真矩阵） |  |
| 快照损坏→恢复 sha256 一致 |  |
## 设计影响

- [ ] 无阻塞，可进 M1 D1/D5  
- [ ] 需新增 ADR（简述）：
