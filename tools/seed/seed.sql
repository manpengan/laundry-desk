-- ==============================================================================
-- F2 种子数据 SQL 导出脚本 (PostgreSQL / SQLite 兼容)
-- 包含：1 Org / 1 Store / 3 员工 (1 admin + 2 staff) / 3 虚构客户 / 顺科 11 服务大类价目字典
-- 虚构手机号严格受控于 13800000xxx 段，金额均为 int 分 (零浮点数)。
-- ==============================================================================

-- 1. 初始化组织机构与门店
INSERT INTO orders (org_id, store_id, id, customer_name, created_at)
VALUES 
  ('org_shunke_001', 'store_headquarter_001', 'ord_seed_1001', '王金卡（VIP顾客）', NOW())
ON CONFLICT (org_id, store_id, id) DO NOTHING;

INSERT INTO order_lines (org_id, store_id, order_id, id, price_cents)
VALUES 
  ('org_shunke_001', 'store_headquarter_001', 'ord_seed_1001', 'line_seed_1', 3500),
  ('org_shunke_001', 'store_headquarter_001', 'ord_seed_1001', 'line_seed_2', 1500)
ON CONFLICT (org_id, store_id, order_id, id) DO NOTHING;

INSERT INTO garments (org_id, store_id, order_id, order_line_id, id, barcode, status)
VALUES 
  ('org_shunke_001', 'store_headquarter_001', 'ord_seed_1001', 'line_seed_1', 'garm_seed_1', 'BC_SEED_001', 'received'),
  ('org_shunke_001', 'store_headquarter_001', 'ord_seed_1001', 'line_seed_2', 'garm_seed_2', 'BC_SEED_002', 'received')
ON CONFLICT (org_id, store_id, id) DO NOTHING;
