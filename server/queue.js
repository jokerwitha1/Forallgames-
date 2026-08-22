// Delivery queue: order assignment, the failure ladder, and the heartbeat reaper.
//
// Failure ladder (each rung only if the previous one didn't recover the order):
//   1. retry        — same order requeued with backoff; the failing bot may retry it
//   2. requeue      — automatic via 1 (order goes back to queued, any eligible bot)
//   3. restart      — after 2 consecutive fails the claim response tells the worker
//                     to restart its Roblox client before attempting again
//   4. reassign     — after MAX_RETRIES fails the bot is excluded for this order
//   5. alert        — no eligible bot left -> manual_review + admin alert

const { db, now, logEvent } = require('./db');

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS || 15_000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 30_000);

function alertAdmin(message) {
  // POC alert channel: log line + optional webhook (e.g. Discord) via env.
  console.error(`[ADMIN ALERT] ${message}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
    }).catch(err => console.error('alert webhook failed:', err.message));
  }
}

function botHasStock(botId, item) {
  const row = db.prepare('SELECT qty FROM bot_inventory WHERE bot_id = ? AND item = ?').get(botId, item);
  return row && row.qty > 0;
}

function eligibleBotExists(order) {
  const excluded = JSON.parse(order.excluded_bots);
  const bots = db.prepare(`SELECT id FROM bots WHERE status != 'disabled'`).all();
  return bots.some(b => !excluded.includes(b.id) && botHasStock(b.id, order.item));
}

// A worker asks for its next order. Returns {order, directives} or null.
function claimNext(botId) {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  if (!bot || bot.status === 'disabled') return null;
  if (bot.current_order) {
    // Worker restarted mid-delivery: hand the same order back.
    const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(bot.current_order);
    if (cur && (cur.status === 'assigned' || cur.status === 'delivering')) {
      return { order: cur, directives: { restart_client: cur.retries >= 2 } };
    }
  }

  const candidates = db.prepare(
    `SELECT * FROM orders WHERE status = 'queued' AND not_before <= ? ORDER BY created_at ASC`
  ).all(now());

  for (const order of candidates) {
    const excluded = JSON.parse(order.excluded_bots);
    if (excluded.includes(botId)) continue;
    if (!botHasStock(botId, order.item)) continue;

    db.prepare(`UPDATE orders SET status = 'assigned', assigned_bot = ?, updated_at = ? WHERE id = ?`)
      .run(botId, now(), order.id);
    db.prepare(`UPDATE bots SET status = 'delivering', current_order = ? WHERE id = ?`)
      .run(order.id, botId);
    logEvent(order.id, 'assigned', `bot=${botId}`);
    return {
      order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id),
      directives: { restart_client: order.retries >= 2 },
    };
  }
  return null;
}

function completeOrder(botId, orderId, verified) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND assigned_bot = ?').get(orderId, botId);
  if (!order) return { error: 'order not assigned to this bot' };
  if (!verified) return failOrder(botId, orderId, 'trade reported complete but not verified');

  db.prepare(`UPDATE orders SET status = 'delivered', fail_reason = NULL, updated_at = ? WHERE id = ?`)
    .run(now(), orderId);
  db.prepare(`UPDATE bot_inventory SET qty = qty - 1 WHERE bot_id = ? AND item = ? AND qty > 0`)
    .run(botId, order.item);
  db.prepare(`UPDATE bots SET status = 'idle', current_order = NULL WHERE id = ?`).run(botId);
  logEvent(orderId, 'delivered', `bot=${botId} verified=true`);
  return { ok: true, status: 'delivered' };
}

function failOrder(botId, orderId, reason) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND assigned_bot = ?').get(orderId, botId);
  if (!order) return { error: 'order not assigned to this bot' };

  db.prepare(`UPDATE bots SET status = 'idle', current_order = NULL WHERE id = ?`).run(botId);
  const retries = order.retries + 1;
  logEvent(orderId, 'failed', `bot=${botId} attempt=${retries} reason=${reason}`);

  if (retries < MAX_RETRIES) {
    // Rungs 1-3: requeue with backoff; same bot may pick it up again.
    db.prepare(
      `UPDATE orders SET status = 'queued', assigned_bot = NULL, retries = ?, not_before = ?,
       fail_reason = ?, updated_at = ? WHERE id = ?`
    ).run(retries, now() + RETRY_BACKOFF_MS, reason, now(), orderId);
    logEvent(orderId, 'requeued', `retry ${retries}/${MAX_RETRIES}, backoff ${RETRY_BACKOFF_MS}ms`);
    return { ok: true, status: 'queued', retries };
  }

  // Rung 4: this bot is out — exclude it and hand the order to another bot.
  const excluded = JSON.parse(order.excluded_bots);
  if (!excluded.includes(botId)) excluded.push(botId);
  db.prepare(
    `UPDATE orders SET assigned_bot = NULL, retries = 0, excluded_bots = ?, fail_reason = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(excluded), reason, now(), orderId);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (eligibleBotExists(updated)) {
    db.prepare(`UPDATE orders SET status = 'queued', not_before = ? WHERE id = ?`)
      .run(now() + RETRY_BACKOFF_MS, orderId);
    logEvent(orderId, 'reassigned', `excluded=${JSON.stringify(excluded)}`);
    return { ok: true, status: 'queued', reassigned: true };
  }

  // Rung 5: nobody can fulfill it.
  db.prepare(`UPDATE orders SET status = 'manual_review' WHERE id = ?`).run(orderId);
  logEvent(orderId, 'manual_review', 'no eligible bot remaining');
  alertAdmin(`Order #${orderId} (${updated.item} -> ${updated.buyer_username}) needs manual review: ${reason}`);
  return { ok: true, status: 'manual_review' };
}

// Heartbeat reaper: a worker that goes silent is marked offline and its order requeued.
function reapStaleWorkers() {
  const cutoff = now() - HEARTBEAT_TIMEOUT_MS;
  const stale = db.prepare(
    `SELECT * FROM bots WHERE status IN ('idle','delivering') AND (last_heartbeat IS NULL OR last_heartbeat < ?)`
  ).all(cutoff);

  for (const bot of stale) {
    db.prepare(`UPDATE bots SET status = 'offline' WHERE id = ?`).run(bot.id);
    if (bot.current_order) {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bot.current_order);
      if (order && (order.status === 'assigned' || order.status === 'delivering')) {
        db.prepare(`UPDATE orders SET status = 'queued', assigned_bot = NULL, updated_at = ? WHERE id = ?`)
          .run(now(), order.id);
        logEvent(order.id, 'requeued', `bot ${bot.id} missed heartbeat`);
      }
      db.prepare(`UPDATE bots SET current_order = NULL WHERE id = ?`).run(bot.id);
      alertAdmin(`Bot ${bot.id} missed heartbeat; order #${bot.current_order} requeued`);
    }
  }
}

module.exports = { claimNext, completeOrder, failOrder, reapStaleWorkers, MAX_RETRIES };
