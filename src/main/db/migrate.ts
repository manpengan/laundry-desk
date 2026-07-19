import type Database from "better-sqlite3";

export function migrate(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      vip_level INTEGER NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS staffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      pickup_code TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'pending',
      total_amount INTEGER NOT NULL,
      paid_amount INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL,
      receive_date INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      expected_pickup_date INTEGER,
      actual_pickup_at INTEGER,
      staff_id INTEGER REFERENCES staffs(id),
      picked_up_by INTEGER REFERENCES staffs(id),
      notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      service_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      item_notes TEXT
    );

    CREATE TABLE IF NOT EXISTS order_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      taken_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      phone TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_response TEXT,
      sent_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER REFERENCES staffs(id),
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      diff TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS orders_pickup_code_idx
      ON orders(pickup_code);
    CREATE INDEX IF NOT EXISTS orders_customer_status_date_idx
      ON orders(customer_id, status, receive_date);
    CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
      ON audit_log(created_at);
  `);
}
