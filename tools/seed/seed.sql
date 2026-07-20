-- ==============================================================================
-- F2 种子数据 SQL 导出脚本
-- 包含：1 机构 (Organization) / 1 门店 (Store) / 3 员工 (1 admin, 2 staff) / 3 客户 (Customers) / 顺科 11 服务大类价目字典
-- 遵循原则：
--   1. 仅导出 F2 基础数据实体，绝对不注入 orders / order_lines / garments 订单业务数据（保护干净安装基线）
--   2. 绝不使用自造条码字面量
--   3. 手机号严格控制在 13800000xxx 虚构段
--   4. 金额均为 int 分 (零浮点数)
--   5. 不依赖特定数据库非标准时间函数 (如 NOW())，保持基础 SQL 兼容
-- ==============================================================================

-- 1. 机构与门店 (Organizations & Stores)
INSERT INTO organizations (id, name, code)
VALUES ('org_shunke_001', '顺科洗衣连锁', 'SHUNKE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO stores (id, org_id, name, code, address, phone)
VALUES ('store_headquarter_001', 'org_shunke_001', '顺科洗衣旗舰总店', 'HQ01', '北京市朝阳区顺科路 88 号大厦 1 层', '13800000000')
ON CONFLICT (id) DO NOTHING;

-- 2. 员工账号 (Staffs: 1 admin + 2 staff)
INSERT INTO staffs (id, org_id, store_id, username, display_name, phone, role, password_hash)
VALUES 
  ('staff_admin_001', 'org_shunke_001', 'store_headquarter_001', 'admin', '店长管理员', '13800000001', 'admin', '$argon2id$v=19$m=65536,t=3,p=4$mock_salt_admin$mock_hash_admin'),
  ('staff_operator_002', 'org_shunke_001', 'store_headquarter_001', 'xiaoli', '李店员（收件柜台）', '13800000002', 'staff', '$argon2id$v=19$m=65536,t=3,p=4$mock_salt_xiaoli$mock_hash_xiaoli'),
  ('staff_operator_003', 'org_shunke_001', 'store_headquarter_001', 'xiaozhang', '张洗涤工（洗涤车间）', '13800000003', 'staff', '$argon2id$v=19$m=65536,t=3,p=4$mock_salt_xiaozhang$mock_hash_xiaozhang')
ON CONFLICT (id) DO NOTHING;

-- 3. 客户列表 (Customers)
INSERT INTO customers (id, org_id, store_id, name, phone, vip_level, balance_cents)
VALUES 
  ('cust_001', 'org_shunke_001', 'store_headquarter_001', '王金卡（VIP顾客）', '13800000101', 2, 50000),
  ('cust_002', 'org_shunke_001', 'store_headquarter_001', '赵普通（常客）', '13800000102', 0, 0),
  ('cust_003', 'org_shunke_001', 'store_headquarter_001', '钱银卡（社区居民）', '13800000103', 1, 15000)
ON CONFLICT (id) DO NOTHING;

-- 4. 顺科 11 服务大类价目字典 (Price Categories & Items)
INSERT INTO price_categories (id, name, icon)
VALUES
  ('cat_wash', '水洗', 'droplet'),
  ('cat_dry_clean', '干洗', 'sparkles'),
  ('cat_iron', '熨烫', 'shirt'),
  ('cat_leather', '皮革护理', 'shield'),
  ('cat_shoes', '鞋靴清洗', 'footprints'),
  ('cat_textile', '窗帘台布', 'blinds'),
  ('cat_luxury', '奢侈品洗护', 'crown'),
  ('cat_dyeing', '染色翻新', 'palette'),
  ('cat_tailoring', '织补修整', 'scissors'),
  ('cat_home', '居家软饰', 'home'),
  ('cat_car_interior', '汽车内饰', 'car')
ON CONFLICT (id) DO NOTHING;

INSERT INTO price_items (id, category_id, category_name, name, service_type, price_cents, unit)
VALUES
  ('item_w01', 'cat_wash', '水洗', '男/女衬衫', 'wash', 1500, '件'),
  ('item_w02', 'cat_wash', '水洗', '休闲 T 恤', 'wash', 1200, '件'),
  ('item_w03', 'cat_wash', '水洗', '短款羽绒服', 'wash', 4500, '件'),
  ('item_w04', 'cat_wash', '水洗', '长款羽绒服', 'wash', 5800, '件'),
  ('item_w05', 'cat_wash', '水洗', '牛仔裤', 'wash', 1800, '条'),
  ('item_d01', 'cat_dry_clean', '干洗', '西装上衣', 'dry_clean', 3500, '件'),
  ('item_d02', 'cat_dry_clean', '干洗', '西裤', 'dry_clean', 2500, '条'),
  ('item_d03', 'cat_dry_clean', '干洗', '羊毛大衣', 'dry_clean', 5800, '件'),
  ('item_d04', 'cat_dry_clean', '干洗', '派克服/风衣', 'dry_clean', 6800, '件'),
  ('item_d05', 'cat_dry_clean', '干洗', '丝绸连衣裙', 'dry_clean', 4800, '件'),
  ('item_i01', 'cat_iron', '熨烫', '衬衫单熨', 'iron', 800, '件'),
  ('item_i02', 'cat_iron', '熨烫', '西裤单熨', 'iron', 1200, '条'),
  ('item_i03', 'cat_iron', '熨烫', '西服套装精烫', 'iron', 2000, '套'),
  ('item_l01', 'cat_leather', '皮革护理', '光面皮衣保养', 'leather', 12800, '件'),
  ('item_l02', 'cat_leather', '皮革护理', '磨砂/翻毛皮衣护理', 'leather', 15800, '件'),
  ('item_l03', 'cat_leather', '皮革护理', '真皮女包上光护理', 'leather', 16800, '个'),
  ('item_s01', 'cat_shoes', '鞋靴清洗', '运动鞋/网面鞋', 'shoes', 2800, '双'),
  ('item_s02', 'cat_shoes', '鞋靴清洗', '休闲皮鞋清洗', 'shoes', 3500, '双'),
  ('item_s03', 'cat_shoes', '鞋靴清洗', '雪地靴/长筒靴', 'shoes', 4800, '双'),
  ('item_t01', 'cat_textile', '窗帘台布', '普通布艺窗帘', 'textile', 1800, '㎡'),
  ('item_t02', 'cat_textile', '窗帘台布', '双层遮光窗帘', 'textile', 2200, '㎡'),
  ('item_t03', 'cat_textile', '窗帘台布', '餐厅提花台布', 'textile', 2500, '张'),
  ('item_x01', 'cat_luxury', '奢侈品洗护', '名牌包深度清洗保养', 'luxury', 29800, '个'),
  ('item_x02', 'cat_luxury', '奢侈品洗护', '高定重工礼服洗护', 'luxury', 38800, '件'),
  ('item_y01', 'cat_dyeing', '染色翻新', '纯棉黑色衣服翻新补色', 'dyeing', 8800, '件'),
  ('item_y02', 'cat_dyeing', '染色翻新', '麂皮绒包局部褪色补色', 'dyeing', 11800, '个'),
  ('item_r01', 'cat_tailoring', '织补修整', '西裤裤脚修改/打边', 'tailoring', 1500, '条'),
  ('item_r02', 'cat_tailoring', '织补修整', '衣服无痕精细织补', 'tailoring', 3000, '处'),
  ('item_r03', 'cat_tailoring', '织补修整', '外套优质拉链更换', 'tailoring', 2000, '条'),
  ('item_h01', 'cat_home', '居家软饰', '布艺沙发套', 'home', 6800, '套'),
  ('item_h02', 'cat_home', '居家软饰', '纯棉床单/被套四件套', 'home', 3800, '套'),
  ('item_h03', 'cat_home', '居家软饰', '蚕丝被/羊毛被芯清洗', 'home', 5800, '床'),
  ('item_c01', 'cat_car_interior', '汽车内饰', '汽车五座全套座套清洗', 'car_interior', 15800, '套'),
  ('item_c02', 'cat_car_interior', '汽车内饰', '全车皮革/大丝圈脚垫冲洗', 'car_interior', 4800, '套')
ON CONFLICT (id) DO NOTHING;

-- 5. 门店基础配置 (Settings)
INSERT INTO settings (org_id, store_id, key, value)
VALUES
  ('org_shunke_001', 'store_headquarter_001', 'fulfillment_enabled', 'true'),
  ('org_shunke_001', 'store_headquarter_001', 'sms_enabled', 'false'),
  ('org_shunke_001', 'store_headquarter_001', 'auto_print_receipt', 'true'),
  ('org_shunke_001', 'store_headquarter_001', 'store_name', '顺科洗衣旗舰总店'),
  ('org_shunke_001', 'store_headquarter_001', 'store_phone', '13800000000'),
  ('org_shunke_001', 'store_headquarter_001', 'receipt_footer_notice', '凭此单取衣，请于 30 日内凭单取件。逾期不领按规定处理。')
ON CONFLICT DO NOTHING;
