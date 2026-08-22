// Worker SIMULATOR — stands in for the Windows Roblox worker so the whole
// pipeline (queue -> claim -> deliver -> verify -> result -> ladder) can be
// exercised end-to-end without touching Roblox. The real Windows worker
// replaces this file by implementing the same HTTP calls (see WORKER_PROTOCOL.md).
//
// Usage: node worker-sim/worker.js <bot_id> [failRate 0..1]
// Env:   API_URL (default http://localhost:3000), API_KEY (default dev-key)

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'dev-key';
const BOT_ID = process.argv[2] || 'bot-1';
const FAIL_RATE = Number(process.argv[3] ?? 0.25);

const FAILURES = ['bot join failed', 'trade declined', 'customer offline', 'trade window timeout'];

async function api(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[${BOT_ID}] ${msg}`);

async function main() {
  await api('/api/worker/register', { bot_id: BOT_ID, roblox_user: `SIM_${BOT_ID}` });
  log(`registered (fail rate ${FAIL_RATE})`);

  setInterval(() => {
    api('/api/worker/heartbeat', { bot_id: BOT_ID }).catch(e => log(`heartbeat failed: ${e.message}`));
  }, 5_000);

  while (true) {
    const { order, directives } = await api('/api/worker/claim', { bot_id: BOT_ID });
    if (!order) { await sleep(3_000); continue; }

    log(`claimed order #${order.id}: ${order.item} -> ${order.buyer_username} (attempt ${order.retries + 1})`);
    if (directives && directives.restart_client) {
      log('directive: restart Roblox client before this attempt (simulated, 2s)');
      await sleep(2_000);
    }

    // Simulate the in-game steps the real worker performs.
    for (const step of ['join_session', 'find_buyer', 'open_trade', 'select_item', 'confirm_trade']) {
      await api('/api/worker/progress', { bot_id: BOT_ID, order_id: order.id, step });
      await sleep(800);
    }

    if (Math.random() < FAIL_RATE) {
      const reason = FAILURES[Math.floor(Math.random() * FAILURES.length)];
      log(`order #${order.id} FAILED: ${reason}`);
      const r = await api('/api/worker/result', { bot_id: BOT_ID, order_id: order.id, success: false, reason });
      log(`server ladder response: ${JSON.stringify(r)}`);
    } else {
      const r = await api('/api/worker/result', { bot_id: BOT_ID, order_id: order.id, success: true, verified: true });
      log(`order #${order.id} delivered (${JSON.stringify(r)})`);
    }
    await sleep(1_000);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
