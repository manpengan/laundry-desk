const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// 数据库连接配置 (通过环境变量传入)
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'laundry_app',
  password: process.env.DB_PASSWORD || 'app_secure_password',
  database: process.env.DB_NAME || 'laundry_v2',
});

// 1. Healthcheck 接口
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// 2. 第一步：假开单 (POST /api/order)
// 创建订单、订单明细行以及衣物，必须事务并注入 RLS 变量
app.post('/api/order', async (req, res) => {
  const { org_id, store_id, order_id, customer_name, line_id, price_cents, garment_id, barcode } = req.body;

  if (!org_id || !store_id || !order_id || !line_id || !garment_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 注意：由于是分立的单次 query 调用，每个参数数组 [val] 中只有 1 个参数，因此占位符必须全部为 $1！
    await client.query("SELECT set_config('app.org_id', $1::text, true)", [org_id]);
    await client.query("SELECT set_config('app.store_id', $1::text, true)", [store_id]);

    // 插入订单
    await client.query(
      `INSERT INTO orders (org_id, store_id, id, customer_name) VALUES ($1::text, $2::text, $3::text, $4::text)`,
      [org_id, store_id, order_id, customer_name]
    );

    // 插入订单行
    await client.query(
      `INSERT INTO order_lines (org_id, store_id, order_id, id, price_cents) VALUES ($1::text, $2::text, $3::text, $4::text, $5::integer)`,
      [org_id, store_id, order_id, line_id, price_cents]
    );

    // 插入衣物
    await client.query(
      `INSERT INTO garments (org_id, store_id, order_id, order_line_id, id, barcode, status) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text)`,
      [org_id, store_id, order_id, line_id, garment_id, barcode, 'received']
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Order created successfully under RLS context' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. 第二步：打印 mock 登记单 (POST /api/print)
// 事务内 RLS 限制下读取订单明细和衣物列表，生成 mock 打印单
app.post('/api/print', async (req, res) => {
  const { org_id, store_id, order_id } = req.body;

  if (!org_id || !store_id || !order_id) {
    return res.status(400).json({ error: 'Missing query parameters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1::text, true)", [org_id]);
    await client.query("SELECT set_config('app.store_id', $1::text, true)", [store_id]);

    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1::text', [order_id]);
    const linesRes = await client.query('SELECT * FROM order_lines WHERE order_id = $1::text', [order_id]);
    const garmentsRes = await client.query('SELECT * FROM garments WHERE order_id = $1::text', [order_id]);

    await client.query('COMMIT');

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRes.rows[0];
    const lines = linesRes.rows;
    const garments = garmentsRes.rows;

    const receipt = `
========================================
       MOCK LAUNDRY RECEIPT (EDGE)
========================================
Tenant Org  : ${org_id}
Store ID    : ${store_id}
Order ID    : ${order.id}
Customer    : ${order.customer_name || 'N/A'}
Date        : ${order.created_at}
----------------------------------------
Order Lines :
${lines.map(l => ` - Line ID: ${l.id}, Price: ¥${(l.price_cents / 100).toFixed(2)}`).join('\n')}
----------------------------------------
Garment Items :
${garments.map(g => ` - Barcode: ${g.barcode}, Status: ${g.status}`).join('\n')}
========================================
`;
    
    console.log('[Mock Printer Driver] Printing simulated receipt:\n', receipt);
    res.json({ success: true, receipt });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. 第三步：取衣 (POST /api/pickup)
app.post('/api/pickup', async (req, res) => {
  const { org_id, store_id, order_id, garment_id } = req.body;

  if (!org_id || !store_id || !order_id || !garment_id) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1::text, true)", [org_id]);
    await client.query("SELECT set_config('app.store_id', $1::text, true)", [store_id]);

    const updateRes = await client.query(
      `UPDATE garments SET status = 'picked_up' WHERE id = $1::text AND order_id = $2::text RETURNING *`,
      [garment_id, order_id]
    );

    await client.query('COMMIT');

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: 'Garment not found or RLS access violation' });
    }

    res.json({ success: true, updated_garment: updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[Mock Edge Server] Listening on port ${port}`);
});
