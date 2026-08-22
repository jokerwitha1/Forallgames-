# Windows Worker Protocol

This is the contract between the delivery server and a Windows worker. One
worker process runs per bot account. The worker owns everything that happens
inside the Roblox client; the server owns orders, inventory records, retries,
and escalation. A worker that implements these five HTTP calls plugs straight
into the pipeline — `worker-sim/worker.js` is a working reference client.

All calls are `POST` with JSON bodies and require the header `X-API-Key`.

## Lifecycle

```
register ──> heartbeat every 5s (always) ──> claim ──> progress* ──> result ──> claim ...
```

### 1. Register — `POST /api/worker/register`

```json
{ "bot_id": "bot-1", "roblox_user": "MM2Stock_One" }
```

Call once on startup (safe to repeat). Marks the bot `idle`.

### 2. Heartbeat — `POST /api/worker/heartbeat`

```json
{ "bot_id": "bot-1", "inventory": { "Chroma Luger": 2, "Harvester": 5 } }
```

Every 5 seconds, no matter what the worker is doing. `inventory` is optional;
when present it **replaces** the server's inventory record for this bot — send
it on startup and after any change you detect. If the server misses heartbeats
for 30s (`HEARTBEAT_TIMEOUT_MS`) it marks the bot offline, requeues its
current order, and alerts the admin.

### 3. Claim — `POST /api/worker/claim`

```json
{ "bot_id": "bot-1" }
```

Response when work is available:

```json
{
  "order": { "id": 12, "buyer_username": "CoolBuyer123", "item": "Chroma Luger", "retries": 2 },
  "directives": { "restart_client": true }
}
```

`{ "order": null }` means nothing to do — poll again in a few seconds. The
server only offers orders for items this bot has in stock. If the worker
crashed mid-delivery, claim returns the same order it was working on.
`directives.restart_client` is true when this order has already failed twice —
restart the Roblox client before attempting the trade.

### 4. Progress — `POST /api/worker/progress` (optional but recommended)

```json
{ "bot_id": "bot-1", "order_id": 12, "step": "open_trade" }
```

Send as the worker moves through its in-game steps (`join_session`,
`find_buyer`, `open_trade`, `select_item`, `confirm_trade`). First call flips
the order to `delivering`; every call is logged, which is what makes failures
diagnosable from the dashboard.

### 5. Result — `POST /api/worker/result`

Success (only after the worker has verified the trade actually completed and
the item left the bot's inventory):

```json
{ "bot_id": "bot-1", "order_id": 12, "success": true, "verified": true }
```

Failure:

```json
{ "bot_id": "bot-1", "order_id": 12, "success": false, "reason": "trade declined" }
```

`success: true` with `verified` missing or false is treated as a failure —
never report delivered without verification. On success the server marks the
order `delivered` and decrements this bot's inventory.

## What the server does with a failure

| Attempt | Server action |
|---|---|
| 1st, 2nd fail | Order requeued with a 15s backoff (`RETRY_BACKOFF_MS`); same bot may retry |
| claim after 2 fails | `directives.restart_client: true` — restart the client first |
| 3rd fail (`MAX_RETRIES`) | Bot excluded for this order; order requeued for another bot with stock |
| No eligible bot left | Order moves to `manual_review`; admin alerted (log + `ALERT_WEBHOOK_URL`) |

The worker never decides any of this — it just reports honestly and asks for
the next order.

## Order states

`pending_payment → queued → assigned → delivering → delivered`
with `manual_review` and `cancelled` as terminal side-exits.

## Server configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `API_KEY` | `dev-key` | shared key for worker/admin/dev calls — change it |
| `MAX_RETRIES` | `3` | failed attempts per bot before reassignment |
| `RETRY_BACKOFF_MS` | `15000` | delay before a failed order is claimable again |
| `HEARTBEAT_TIMEOUT_MS` | `30000` | silence before a bot is reaped |
| `ALERT_WEBHOOK_URL` | – | optional webhook (e.g. Discord) for admin alerts |
| `DATA_DIR` | `./data` | where the SQLite database lives |
