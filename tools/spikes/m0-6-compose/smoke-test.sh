#!/usr/bin/env bash
set -e

# 切入脚本所在目录，防止 Cwd 不一致
cd "$(dirname "$0")"

# ==============================================================================
# V2-M0-6 Compose and RLS Isolation Smoke Test Script
# 演练内容:
#   1. 一键拉起 PG16 + Mock Server 双容器
#   2. 等待 Healthcheck
#   3. HTTP API 三步往返测试 (假开单 -> 打印(mock) -> 正常取衣)
#   4. RLS 安全防护边界测试 (Tenant B 越权取 Tenant A 衣物被拦截)
#   5. Postgres 物理主键、外键约束逻辑校验
# ==============================================================================

echo "=== [M0-6 Spike] [LOCAL_ONLY] 1. Rebuilding and launching docker-compose services ==="
# 注意：曾硬编码 DOCKER_BUILDKIT=0 / COMPOSE_DOCKER_CLI_BUILD=0 强制 legacy builder，
# 但 Docker 28+ 已移除该 builder，构建会无限挂起（实测 >8 分钟 CPU 0%）。
# 现使用默认 BuildKit；如需在极旧 Docker 上运行，请自行 export 上述变量。
docker compose down -v || true
docker compose build --no-cache mock-edge-server
docker compose up -d

echo "=== [M0-6 Spike] 2. Waiting for Postgres and Mock Server health checks ==="
# 等待 Postgres 健康
until [ "$(docker inspect --format='{{json .State.Health.Status}}' laundry-postgres-spike)" == "\"healthy\"" ]; do
  echo "Waiting for Postgres container to become healthy..."
  sleep 2
done
echo "✔ Postgres container is HEALTHY."

# 等待 Mock Server 健康
until [ "$(docker inspect --format='{{json .State.Health.Status}}' laundry-mock-edge-server-spike)" == "\"healthy\"" ]; do
  echo "Waiting for Mock Edge Server container to become healthy..."
  sleep 2
done
echo "✔ Mock Edge Server container is HEALTHY."

# 3. HTTP API 三步往返与 RLS 强隔离边界测试
echo -e "\n=== [M0-6 Spike] 3. Starting HTTP API Round-Trip & Security Boundary Tests ==="

# Step A: 假开单
echo -e "\n[Step A] Creating order (Order: ord_1001, Tenant: org_aaa/store_1)..."
curl -s -X POST http://localhost:8080/api/order \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "org_aaa",
    "store_id": "store_1",
    "order_id": "ord_1001",
    "customer_name": "张三",
    "line_id": "line_1",
    "price_cents": 2900,
    "garment_id": "garm_1",
    "barcode": "BC_0001"
  }' | json_pp || echo "Curl error"

# Step B: 打印 mock 登记单
echo -e "\n[Step B] Fetching & Printing Receipt (Order: ord_1001, Tenant: org_aaa/store_1)..."
curl -s -X POST http://localhost:8080/api/print \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "org_aaa",
    "store_id": "store_1",
    "order_id": "ord_1001"
  }' | json_pp || echo "Curl error"

# Step C: RLS 越权测试 - 使用 Tenant B (org_bbb) 身份去操作 Tenant A 的衣服
echo -e "\n[Step C - SECURITY] Attempting unauthorized pickup using Tenant B context..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/api/pickup \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "org_bbb",
    "store_id": "store_2",
    "order_id": "ord_1001",
    "garment_id": "garm_1"
  }')

if [ "$HTTP_STATUS" == "404" ]; then
  echo "✔ [PASS] Security Isolation Working! Server blocked unauthorized request with status 404 (Not Found or RLS violation)."
else
  echo "❌ [FAIL] RLS breach! Server returned status code $HTTP_STATUS instead of 404."
  exit 1
fi

# Step D: 正常取衣
echo -e "\n[Step D] Performing legitimate pickup using Tenant A context..."
curl -s -X POST http://localhost:8080/api/pickup \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "org_aaa",
    "store_id": "store_1",
    "order_id": "ord_1001",
    "garment_id": "garm_1"
  }' | json_pp || echo "Curl error"


# 4. Postgres 物理主键、外键约束逻辑校验
echo -e "\n=== [M0-6 Spike] 4. Running Database Constraint and internal RLS Validation ==="

# Test 1: 在未设置 app.org_id / app.store_id 会话变量时执行查询，默认应返回 0 行 (Default-closed)
echo "Running Test 1: default-closed behavior without session variables..."
docker exec -i laundry-postgres-spike psql -U laundry_app -d laundry_v2 -c "
  SELECT count(*) FROM orders;
"

# Test 2: 设置正确的 org_aaa 会话变量，验证正常读取数据
echo "Running Test 2: reading data inside legitimate session..."
docker exec -i laundry-postgres-spike psql -U laundry_app -d laundry_v2 -c "
  BEGIN;
  SET LOCAL app.org_id = 'org_aaa';
  SET LOCAL app.store_id = 'store_1';
  SELECT id, customer_name FROM orders;
  COMMIT;
"

# Test 3: 对比组 - 使用 org_bbb 身份，验证其数据被完全物理强隔离 (返回 0 行)
echo "Running Test 3: checking multi-tenant isolation under tenant org_bbb..."
docker exec -i laundry-postgres-spike psql -U laundry_app -d laundry_v2 -c "
  BEGIN;
  SET LOCAL app.org_id = 'org_bbb';
  SET LOCAL app.store_id = 'store_2';
  SELECT count(*) FROM orders;
  COMMIT;
"

# Test 4: 违反 4 元外键约束校验 - 尝试在插入衣服时，关联到其他订单的 order_line 上 (应触发 constraint error 拦截)
echo "Running Test 4: checking cross-order foreign key constraint breach prevention..."
docker exec -i laundry-postgres-spike psql -U laundry_owner -d laundry_v2 -c "
  -- 尝试往 orders/order_lines 插入另外一条数据
  INSERT INTO orders (org_id, store_id, id, customer_name) VALUES ('org_aaa', 'store_1', 'ord_2002', '李四');
  INSERT INTO order_lines (org_id, store_id, order_id, id, price_cents) VALUES ('org_aaa', 'store_1', 'ord_2002', 'line_2', 3900);
" || true

echo -e "\n[Test 4 Constraint Action] Attempting to insert a garment with mismatched order_id and order_line_id..."
# 必须以 laundry_app + 正确 GUC 执行：owner 无 BYPASSRLS 且无策略覆盖，
# 用 owner 会被 FORCE RLS 直接拒绝，根本走不到外键校验（曾导致本用例假阳性）。
# 断言也必须校验错误类型——只判非零退出会把 RLS 拒绝误认成外键生效。
T4_OUT=$(docker exec -i laundry-postgres-spike psql -U laundry_app -d laundry_v2 -c "
  BEGIN;
  SET LOCAL app.org_id = 'org_aaa';
  SET LOCAL app.store_id = 'store_1';
  -- 李四订单的衣服，试图越权绑定到张三的 line_1 上！(此时 order_id 错位)
  INSERT INTO garments (org_id, store_id, order_id, order_line_id, id, barcode, status)
  VALUES ('org_aaa', 'store_1', 'ord_2002', 'line_1', 'garm_bad', 'BC_BAD', 'received');
  COMMIT;
" 2>&1) || true
echo "$T4_OUT"
if echo "$T4_OUT" | grep -q "violates foreign key constraint"; then
  echo "✔ [PASS] 四元外键真实生效：跨订单挂靠被 FK 拦截。"
elif echo "$T4_OUT" | grep -q "violates row-level security policy"; then
  echo "✘ [FAIL] 被 RLS 拦截而非外键——执行身份/GUC 有误，本用例未真正验证四元外键。"
  exit 1
else
  echo "✘ [FAIL] 插入未被拦截或出现未预期错误，四元外键可能失效。"
  exit 1
fi

echo -e "\n=== [M0-6 Spike] All Smoke Tests Completed successfully ==="
