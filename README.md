# MM2 Auto-Delivery — Phase 1 POC

Server-side core of the MM2 automated delivery system:

```
Website/API  →  Delivery Queue  →  Worker (per bot)  →  Trade Verification  →  Order Updated
```

This repo contains everything except the Windows client-control layer:

| Piece | Where | Status |
|---|---|---|
| Orders API + payment webhook stub | `server/index.js` | ✅ built |
| Delivery queue, retry/escalation ladder, heartbeat reaper | `server/queue.js` | ✅ built |
| SQLite persistence (orders, bots, per-bot inventory, event log) | `server/db.js` | ✅ built |
| Admin dashboard (live bots/orders/events) | `public/admin.html` | ✅ built |
| Worker protocol spec for the Windows implementation | `WORKER_PROTOCOL.md` | ✅ built |
| Worker **simulator** (drives the pipeline end-to-end) | `worker-sim/worker.js` | ✅ built |
| Windows Roblox client-control worker | — | implements `WORKER_PROTOCOL.md` |
| Architecture diagram | `docs/mm2-delivery-flow.html` | ✅ built |

## Run the demo

```bash
npm install
npm start                                   # API + dashboard on :3000
```

In a second terminal:

```bash
curl -X POST localhost:3000/api/dev/seed -H "X-API-Key: dev-key"   # 2 bots, stock, 3 paid orders
node worker-sim/worker.js bot-1 0.25 &      # simulated worker, 25% fail rate
node worker-sim/worker.js bot-2 0.25 &
```

Open http://localhost:3000/admin.html (key `dev-key`) and watch orders move
through the queue, fail, retry, reassign between bots, and escalate to manual
review — the full failure ladder from the architecture diagram.

Create a real order:

```bash
curl -X POST localhost:3000/api/orders \
  -H "content-type: application/json" \
  -d '{"buyer_username":"SomeBuyer","item":"Harvester"}'
# → {"order_id":4,"status":"pending_payment"}

curl -X POST localhost:3000/api/payments/webhook \
  -H "content-type: application/json" -H "X-API-Key: dev-key" \
  -d '{"order_id":4}'                        # gateway confirms → order queued
```

## Design rules baked into the server

- **Verification gates delivery**: a result without `verified: true` is a failure.
- **Inventory is per bot**: the queue only assigns an order to a bot that stocks the item; stock is decremented only on verified delivery.
- **The ladder lives server-side**: retry with backoff → restart directive → reassign to another bot → manual review + admin alert. Workers just report honestly.
- **Heartbeats are liveness**: 30s of silence reaps the bot and requeues its order.
- **Everything is logged** per order in `order_events` — the dashboard shows the trail.

Configuration is via environment variables — see the table at the end of
`WORKER_PROTOCOL.md`. Set a real `API_KEY` before exposing the server anywhere.
