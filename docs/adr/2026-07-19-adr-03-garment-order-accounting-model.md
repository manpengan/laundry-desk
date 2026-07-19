# ADR-03: 件级衣物 / 订单行 / 账务状态模型

- 日期：2026-07-19　状态：Proposed　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §7

## 决策

1. **计价与实物分离**：
   - `order_lines`：计价行（品类、服务、`qty`、单价、行折扣、附加）——金额归行；
   - `garments`：实物件，**每件一条、无 qty、唯一条码**，持有颜色/品牌/瑕疵/照片/状态/格位/`rfid_tag_id`（预留）。开单 `line.qty=3` ⇒ 生成 3 条 garment。
2. 件级状态机为唯一流转真源（domain 层显式转移表）：`received → washing → ready → racked → picked_up | delivered`；`reworked` 回环；`lost` 高危终态；**`delivered`（回送签收）补入转移表**；`fulfillment` 关闭时坍缩为 `received → picked_up | delivered`。全部流转写 `garment_status_log`。
3. 订单状态：`draft → open → closed / cancelled(必填原因)`；closed 条件 = 全部件到终态且欠款清零；撤销产生回冲分录，不删数据。
4. 金额规则：整数分；`payable` 计算唯一落在 `packages/domain`；会员余额、积分只能由 ledger 派生（`member_ledger` 金额三元组：本金/赠额分列）。
5. 账务双口径产品化：真实收入 / 业绩收入（排除储值款、含刷卡消费），同一 domain 函数供报表与账目共用。
6. **租户组合键（三审修正为三元）**：店级父表 `UNIQUE(org_id, store_id, id)`；子表三元组合外键，`garments → order_lines` 含 `order_id`（详见 ADR-02 第 8 条）。
7. **支付流水只追加**：`payments` 无 UPDATE/DELETE，更正一律红冲分录（`kind=reversal` 引用原分录）。
8. 票号不变量（三审去"单调"）：门店内**唯一、永不复用**；空洞**与离线乱序**可审计（多设备号段不承诺按时间单调，**时间排序一律用 ULID/created_at**）；营业日按门店时区、跨零点可配；解绑设备的未用号段永久作废。

## 理由

draft1 的 `garments.qty` 与"件是最小流转对象"自相矛盾（二审 P0）：qty>1 时部分取衣、掉标、单件返工无法准确表达；`delivered` 在枚举却不在转移表。拆分后部分取衣 = 勾选 garment 集合，天然成立。

## 否决的备选

- v1 的"品类×数量"单表（无法件级追踪，正是与顺科的核心差距）。
- 只有 garments 无 order_lines（打折/改价需在件间摊分，计价复杂化且对账困难）。

## 后果

- 迁移器需按 qty 拆行生成件并补发条码（ADR-07）。
- 水洗唛/不干胶打印、上挂、催取、店厂交接全部以 garment.barcode 为主键操作。
