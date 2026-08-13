# Stage 4.4 Item 9 推荐与团购验收记录

- 日期：2026-08-13
- ADR：[ADR-54](../../adr/2026-08-13-adr-54-referral-and-group-buy.md)
- 状态：实现候选；真实 PostgreSQL 定点业务事务与完整本地 package 门禁已通过，独立安全复审待刷新；
  部署、公网浏览器与 exact-SHA CI 另行验收

## 本片验收口径

| 层         | 必须证明                                                           | 不能替代           |
| ---------- | ------------------------------------------------------------------ | ------------------ |
| Contract   | 3 写 0 读、65/43 freeze、strict、R4、secret redaction              | UI 表单            |
| PostgreSQL | `0063`、FORCE store RLS、复合 FK、append-only、精确预算与单次核销  | memory store       |
| Server     | 推荐/订单/券资格重算、确定锁序、WYSIWYS 漂移失败关闭、幂等         | campaign scheduled |
| Web        | 本机摘要、完整复核摘要、原码不进 HTTP、两类续跑                    | API 单测           |
| 隐私       | 无姓名/手机号/地址/原码投影；account id 与 digest 不进公开确认摘要 | SHA-256 本身       |

## 自动化用例

1. 三条输入拒绝 tenant、store、金额 authority 与未知字段；推荐双方不能相同。
2. 团购原码不足 24 位、格式不符或末四位含连接符时在浏览器本机失败；固定域摘要有确定向量。
3. 三条首跳都只创建 R4 pending card，不写权益/订单；复核卡逐字段呈现全部公开 authority，且不含
   account id、digest 或原始券码。
4. 推荐要求 active 不同会员、canonical 顾客、被推荐人 closed/paid/zero-balance 订单、active 券和窗口内
   scheduled 活动；任一漂移不写 grant/reward/ledger。
5. 推荐成功时 grant、reward 和等额 budget ledger 同事务各写一次；同订单或同活动/被推荐人不能换推荐人
   再领。首次奖励恰好耗尽预算后，即使活动随后结束且券退役，使用新幂等键的完整同语义重放仍返回原
   reward，各表保持一条；原因或其他语义漂移失败关闭。
6. 团购登记只存摘要/末四位，平台订单和摘要分别唯一，有效期晚于登记且不超过五年。
7. 团购核销要求同店 open、未付款、零既有折扣订单；金额固定为面值与原价较小值，更新订单与 redemption
   同事务，一券/一订单各只能核销一次。
8. app role 跨店读取/写入失败；三张证据表不能 UPDATE/DELETE/TRUNCATE，数据库 trigger 能拒绝伪造
   推荐 grant/预算和不匹配的订单折扣。
9. 三条命令经过营销专用 session+org+store 限流，feature 默认关闭，offline/Edge/AI 均无入口。
10. PostgreSQL 16 已从空库 apply `0001–0053`、`0059`、`0060`、`0063`，定点业务事务证明推荐奖励、
    团购登记/核销、订单改价、跨店 RLS、app role 禁止更新及终态精确 replay；完整 bundle/replay 仍由
    最终集成门禁刷新。
11. Web 延迟请求门禁覆盖推荐活动 A→B、本机摘要期间编辑/重复点击和 session quick-switch；旧 generation
    不能安装复核卡、应用结果或发出 toast。

## 明确保留

- 推荐链接/邀请码采集、设备指纹、图谱或风控评分；当前只验证管理员提交的已结清订单归因。
- 外部团购商品创建、支付、退款、provider API、签名 webhook、平台对账和联网验真。
- Items 10–11 顾客自助订单/票据/钱包/券包/地址/偏好。
- 通知触达、AI/automation、Edge/offline、原生移动 App。
- hk-vps 部署、remote marker、public Browser 与 exact-SHA CI。

以上保留项没有证据时，不得把“团购券已登记/核销”写成“外部平台已完成结算”，也不得把一次推荐
奖励称为完整反作弊推荐系统。
