const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mm2.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id             TEXT PRIMARY KEY,
  roblox_user    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'offline',  -- idle | delivering | offline | disabled
  current_order  INTEGER,
  last_heartbeat INTEGER,                          -- unix ms
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_inventory (
  bot_id TEXT NOT NULL,
  item   TEXT NOT NULL,
  qty    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, item)
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_username TEXT NOT NULL,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_payment',
  -- pending_payment | queued | assigned | delivering | delivered | manual_review | cancelled
  assigned_bot   TEXT,
  excluded_bots  TEXT NOT NULL DEFAULT '[]',       -- JSON array of bot ids that failed this order
  retries        INTEGER NOT NULL DEFAULT 0,       -- failed attempts on the current bot
  not_before     INTEGER NOT NULL DEFAULT 0,       -- retry backoff: not claimable before this time
  fail_reason    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  event    TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
`);

function now() { return Date.now(); }

function logEvent(orderId, event, detail = '') {
  db.prepare('INSERT INTO order_events (order_id, ts, event, detail) VALUES (?, ?, ?, ?)')
    .run(orderId, now(), event, String(detail));
}

module.exports = { db, now, logEvent };
