-- 1. 角色初始化
-- 创建 laundry_owner 用于 migrations 和表定义变更
-- 仅限本地 / LOCAL ONLY: mock credential for local development spike
CREATE ROLE laundry_owner WITH LOGIN CREATEDB PASSWORD 'owner_secure_password';

-- 创建 laundry_app 用户，开启 NOBYPASSRLS 限制，强制执行 Row Level Security
-- 仅限本地 / LOCAL ONLY: mock credential for local development spike
CREATE ROLE laundry_app WITH LOGIN NOBYPASSRLS PASSWORD 'app_secure_password';

-- 授权 laundry_owner 数据库权限
ALTER DATABASE laundry_v2 OWNER TO laundry_owner;

-- 切到 laundry_owner 身份创建表，确保所有者不是 app 角色
\c laundry_v2 laundry_owner;

-- 2. 最小三表结构设计（对齐架构 §7 四元约束设计）
-- 订单表 orders (org_id, store_id, id) 三元主键
CREATE TABLE orders (
    org_id VARCHAR(50) NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    id VARCHAR(50) NOT NULL,
    customer_name VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (org_id, store_id, id)
);

-- 订单行表 order_lines (对齐架构，增加 order_id 作为四元标识组成部分)
CREATE TABLE order_lines (
    org_id VARCHAR(50) NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    id VARCHAR(50) NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, store_id, order_id, id), -- 四元主键
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES orders(org_id, store_id, id) ON DELETE CASCADE
);

-- 件级衣物表 garments (含 order_id 防同店跨订单挂行)
CREATE TABLE garments (
    org_id VARCHAR(50) NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    order_line_id VARCHAR(50) NOT NULL,
    id VARCHAR(50) NOT NULL,
    barcode VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    PRIMARY KEY (org_id, store_id, id),
    -- garments 引用 order_lines 必须走四元组合外键，且包含 order_id，物理防范跨单越权关联
    FOREIGN KEY (org_id, store_id, order_id, order_line_id) REFERENCES order_lines(org_id, store_id, order_id, id) ON DELETE CASCADE
);

-- 3. 授权 app 用户基础读写权限
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_lines TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON garments TO laundry_app;

-- 4. 开启 RLS 物理强隔离并 FORCE RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE garments ENABLE ROW LEVEL SECURITY;
ALTER TABLE garments FORCE ROW LEVEL SECURITY;

-- 5. 定义 RLS 行级隔离策略 (基于会话级 GUC 参数 app.org_id 和 app.store_id)
CREATE POLICY tenant_isolation_policy ON orders
    FOR ALL
    TO laundry_app
    USING (
        org_id = current_setting('app.org_id', true)
        AND store_id = current_setting('app.store_id', true)
    );

CREATE POLICY tenant_isolation_policy ON order_lines
    FOR ALL
    TO laundry_app
    USING (
        org_id = current_setting('app.org_id', true)
        AND store_id = current_setting('app.store_id', true)
    );

CREATE POLICY tenant_isolation_policy ON garments
    FOR ALL
    TO laundry_app
    USING (
        org_id = current_setting('app.org_id', true)
        AND store_id = current_setting('app.store_id', true)
    );

-- ==============================================================================
-- 6. 修正：owner 维护策略 + 显式 WITH CHECK
-- ==============================================================================
-- 问题：表开了 FORCE ROW LEVEL SECURITY，而策略只 TO laundry_app，
-- laundry_owner 又无 BYPASSRLS ⇒ owner 对数据「零可见、零可写」
-- （实测 SELECT count(*) FROM orders 返回 0）。
-- 后果：DDL 可行，但任何迁移回填 / seed / 数据修复都会静默失败或报错。
-- 架构 §4 规定「迁移用独立 owner 角色」，故 owner 必须能跨租户操作数据。
CREATE POLICY maintenance_policy ON orders      FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY maintenance_policy ON order_lines FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY maintenance_policy ON garments    FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

-- 显式补 WITH CHECK：架构 §4 要求策略模板 USING(读) 与 WITH CHECK(写入约束) 两半齐备。
-- FOR ALL 省略 WITH CHECK 时 PG 会复用 USING，但显式声明才能作为冻结模板被复用。
ALTER POLICY tenant_isolation_policy ON orders      TO laundry_app
    USING      (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true))
    WITH CHECK (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true));
ALTER POLICY tenant_isolation_policy ON order_lines TO laundry_app
    USING      (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true))
    WITH CHECK (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true));
ALTER POLICY tenant_isolation_policy ON garments    TO laundry_app
    USING      (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true))
    WITH CHECK (org_id = current_setting('app.org_id', true) AND store_id = current_setting('app.store_id', true));
