CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  vip_level INTEGER NOT NULL,
  total_orders INTEGER NOT NULL,
  total_spent INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  pickup_code TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  paid_amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  receive_date INTEGER,
  expected_pickup_date INTEGER,
  actual_pickup_at INTEGER,
  staff_id INTEGER,
  picked_up_by INTEGER,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  service_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  subtotal INTEGER NOT NULL,
  item_notes TEXT
);
CREATE TABLE order_photos (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  taken_at INTEGER
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);

INSERT INTO customers VALUES (1, '测试顾客甲', '13800000101', 0, 1, 4500, 1720000000, 1720000000);
INSERT INTO customers VALUES (2, '测试顾客乙', '13800000102', 1, 1, 3000, 1720000000, 1720000100);
INSERT INTO orders VALUES (1, '20240703-0001', '1357', 1, 'picked_up', 4500, 4500, 'cash', 1720000000, NULL, 1720003600, 1, 1, '虚构备注', 1720000000, 1720003600);
INSERT INTO orders VALUES (2, '20240703-0002', '2468', 2, 'ready', 3000, 1000, 'wechat', 1720000200, 1720086400, NULL, 1, NULL, NULL, NULL, 1720000300);
INSERT INTO order_items VALUES (11, 1, '虚构衬衫', 'wash', 3, 1500, 4500, '袖口重点');
INSERT INTO order_items VALUES (12, 2, '虚构大衣', 'dry_clean', 2, 1500, 3000, NULL);
INSERT INTO order_photos VALUES (21, 1, '2024-07/20240703-0001_1.jpg', 1720000010);
INSERT INTO settings VALUES ('price_templates', '[{"itemType":"虚构衬衫","serviceType":"wash","price":1500}]', 1720000000);
INSERT INTO settings VALUES ('shop.name', '虚构洗衣店', 1720000000);
