const express = require('express');
const path = require('path');
const { db, now, logEvent } = require('./db');
const queue = require('./queue');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || 'dev-key'; // set a real key outside local dev

// Workers, admin, and dev endpoints all authenticate with X-API-Key.
function requireKey(req, res, next) {
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  next();
}

/* ------------------------- storefront (public) ------------------------- */

// Create an order. In production the store front-end calls this after checkout;
// the order sits in pending_payment until the gateway webhook confirms it.
app.post('/api/orders', (req, res) => {
  const { buyer_username, item } = req.body || {};
  if (!buyer_username || !item) return res.status(400).json({ error: 'buyer_username and item required' });
  const t = now();
  const info = db.prepare(
    `INSERT INTO orders (buyer_username, item, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(String(buyer_username), String(item), t, t);
  logEvent(info.lastInsertRowid, 'created', `item=${item} buyer=${buyer_username}`);
  res.json({ order_id: info.lastInsertRowid, status: 'pending_payment' });
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT id, buyer_username, item, status, created_at, updated_at FROM orders WHERE id = ?')
    .get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json(order);
});

/* --------------------- payment gateway webhook (stub) ------------------ */

// Replace with your real gateway's webhook (verify its signature there).
// On confirmed payment the order enters the delivery queue.
app.post('/api/payments/webhook', requireKey, (req, res) => {
  const { order_id } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'not found' });
  if (order.status !== 'pending_payment') return res.status(409).json({ error: `order is ${order.status}` });
  db.prepare(`UPDATE orders SET status = 'queued', updated_at = ? WHERE id = ?`).run(now(), order_id);
  logEvent(order_id, 'payment_verified', '');
  logEvent(order_id, 'queued', '');
  res.json({ ok: true, status: 'queued' });
});

/* ----------------------------- worker API ------------------------------ */

// Register (or re-register) a worker for one bot account.
app.post('/api/worker/register', requireKey, (req, res) => {
  const { bot_id, roblox_user } = req.body || {};
  if (!bot_id) return res.status(400).json({ error: 'bot_id required' });
  db.prepare(
    `INSERT INTO bots (id, roblox_user, status, last_heartbeat, created_at)
     VALUES (?, ?, 'idle', ?, ?)
     ON CONFLICT(id) DO UPDATE SET roblox_user = excluded.roblox_user, status = 'idle', last_heartbeat = excluded.last_heartbeat`
  ).run(bot_id, roblox_user || '', now(), now());
  res.json({ ok: true });
});

// Heartbeat: keeps the bot alive, optionally syncs its full inventory.
app.post('/api/worker/heartbeat', requireKey, (req, res) => {
  const { bot_id, inventory } = req.body || {};
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot_id);
  if (!bot) return res.status(404).json({ error: 'unknown bot; register first' });
  const status = bot.current_order ? 'delivering' : (bot.status === 'disabled' ? 'disabled' : 'idle');
  db.prepare(`UPDATE bots SET last_heartbeat = ?, status = ? WHERE id = ?`).run(now(), status, bot_id);
  if (inventory && typeof inventory === 'object') {
    const upsert = db.prepare(
      `INSERT INTO bot_inventory (bot_id, item, qty) VALUES (?, ?, ?)
       ON CONFLICT(bot_id, item) DO UPDATE SET qty = excluded.qty`
    );
    const sync = db.transaction(inv => {
      db.prepare('DELETE FROM bot_inventory WHERE bot_id = ?').run(bot_id);
      for (const [item, qty] of Object.entries(inv)) upsert.run(bot_id, String(item), Number(qty));
    });
    sync(inventory);
  }
  res.json({ ok: true });
});

// Claim the next deliverable order for this bot.
app.post('/api/worker/claim', requireKey, (req, res) => {
  const { bot_id } = req.body || {};
  const claimed = queue.claimNext(bot_id);
  if (!claimed) return res.json({ order: null });
  const { order, directives } = claimed;
  res.json({
    order: { id: order.id, buyer_username: order.buyer_username, item: order.item, retries: order.retries },
    directives,
  });
});

// Worker marks the trade as started (for the dashboard's live status).
app.post('/api/worker/progress', requireKey, (req, res) => {
  const { bot_id, order_id, step } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND assigned_bot = ?').get(order_id, bot_id);
  if (!order) return res.status(404).json({ error: 'order not assigned to this bot' });
  if (order.status === 'assigned') {
    db.prepare(`UPDATE orders SET status = 'delivering', updated_at = ? WHERE id = ?`).run(now(), order_id);
  }
  logEvent(order_id, 'progress', `bot=${bot_id} step=${step || ''}`);
  res.json({ ok: true });
});

// Final result for an attempt. success requires verified=true.
app.post('/api/worker/result', requireKey, (req, res) => {
  const { bot_id, order_id, success, verified, reason } = req.body || {};
  const result = success
    ? queue.completeOrder(bot_id, order_id, Boolean(verified))
    : queue.failOrder(bot_id, order_id, reason || 'unspecified failure');
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

/* ------------------------------ admin API ------------------------------ */

app.get('/api/admin/state', requireKey, (req, res) => {
  const bots = db.prepare('SELECT * FROM bots ORDER BY id').all().map(b => ({
    ...b,
    inventory: db.prepare('SELECT item, qty FROM bot_inventory WHERE bot_id = ? ORDER BY item').all(b.id),
    heartbeat_age_s: b.last_heartbeat ? Math.round((now() - b.last_heartbeat) / 1000) : null,
  }));
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all();
  const events = db.prepare('SELECT * FROM order_events ORDER BY id DESC LIMIT 100').all();
  res.json({ bots, orders, events, max_retries: queue.MAX_RETRIES });
});

// Resolve a manual_review order after handling it by hand.
app.post('/api/admin/resolve', requireKey, (req, res) => {
  const { order_id, outcome } = req.body || {}; // outcome: delivered | cancelled | requeue
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'not found' });
  if (outcome === 'requeue') {
    db.prepare(`UPDATE orders SET status = 'queued', excluded_bots = '[]', retries = 0, updated_at = ? WHERE id = ?`)
      .run(now(), order_id);
  } else if (outcome === 'delivered' || outcome === 'cancelled') {
    db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`).run(outcome, now(), order_id);
  } else {
    return res.status(400).json({ error: 'outcome must be delivered, cancelled, or requeue' });
  }
  logEvent(order_id, 'admin_resolved', outcome);
  res.json({ ok: true });
});

/* ------------------------------ dev helpers ---------------------------- */

// Seed demo bots + inventory + a few paid orders so the dashboard has life.
app.post('/api/dev/seed', requireKey, (req, res) => {
  const t = now();
  const bots = [
    ['bot-1', 'MM2Stock_One', { 'Chroma Luger': 2, 'Batwing': 3, 'Harvester': 5 }],
    ['bot-2', 'MM2Stock_Two', { 'Chroma Luger': 1, 'Icebreaker': 4, 'Harvester': 2, 'Swirly Axe': 6 }],
  ];
  for (const [id, user, inv] of bots) {
    db.prepare(`INSERT OR IGNORE INTO bots (id, roblox_user, status, created_at) VALUES (?, ?, 'offline', ?)`)
      .run(id, user, t);
    for (const [item, qty] of Object.entries(inv)) {
      db.prepare(`INSERT INTO bot_inventory (bot_id, item, qty) VALUES (?, ?, ?)
                  ON CONFLICT(bot_id, item) DO UPDATE SET qty = excluded.qty`).run(id, item, qty);
    }
  }
  const demo = [['CoolBuyer123', 'Chroma Luger'], ['xX_Knife_Fan_Xx', 'Harvester'], ['epicgamer900', 'Batwing']];
  for (const [buyer, item] of demo) {
    const info = db.prepare(`INSERT INTO orders (buyer_username, item, status, created_at, updated_at)
                             VALUES (?, ?, 'queued', ?, ?)`).run(buyer, item, t, t);
    logEvent(info.lastInsertRowid, 'created', 'seeded');
    logEvent(info.lastInsertRowid, 'queued', 'seeded as paid');
  }
  res.json({ ok: true });
});

/* ----------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, '..', 'public')));

setInterval(() => queue.reapStaleWorkers(), 5_000);

app.listen(PORT, () => {
  console.log(`MM2 delivery API listening on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin.html (API key: ${API_KEY === 'dev-key' ? 'dev-key (default)' : 'set via env'})`);
});
