# vibe-mcp Session Notes

## Jan 30, 2026 — Phase 1 Presence Bridge

**Spec:** `/Users/seth/VIBE_CLAWDBOT_INTEGRATION_SPEC.md`
**Deliverable:** Add `source: "mcp"` to all presence tool calls

### Phase 1 Progress

- [x] `store/api.js` — `heartbeat()` accepts new `source` param (4th arg), passes to API payload
- [x] `tools/status.js` — heartbeat call includes `source: "mcp"`
- [x] `tools/context.js` — both heartbeat calls (set + clear) include `source: "mcp"`
- [x] `presence.js` — background heartbeat interval includes `source: "mcp"`
- [x] `presence.js` — `forceHeartbeat()` includes `source: "mcp"`
- [x] **Platform API already supports it** — `api/presence.js` line 355 destructures `source`, lines 579-631 merge into JSONB

### Not in scope (other heartbeat callers)

- `tools/init.js` — Registration heartbeats (don't need source tracking, one-time)
- `tools/token.js` — Token refresh heartbeat (one-time)

### Also shipped this session (pre-Phase 1)

- `bridges/agent-gateway.js` — Agent registration, AIRC verification, event push subscriptions, local memory queries
- `protocol/index.js` — New `agent` wire schema (session_sync, heartbeat, capability_announce, etc.)
- `notify.js` — `pushToAgents()` for event push to subscribed gateways
- `tools/dm.js` — Pushes `dm` event to subscribed agents
- `tools/ship.js` — Pushes `ship` event to subscribed agents
- `tools/handoff.js` — Pushes `handoff` event to subscribed agents
- `debug.js` — Standalone debug module for non-tool code

### Blocked On

- ~~**vibe-platform** needs to accept `source` field~~ — RESOLVED: columns deployed, API wired
- **seth-agent** needs to call `vibe_status` + `vibe_context` with `source: "clawdbot"` on session checkin/checkout

### Verification (Jan 30, 2026)

Platform confirmed end-to-end:
```
POST /api/presence {source: "clawdbot", reach_via: ["whatsapp","telegram","discord"]}
POST /api/presence {source: "mcp"}
GET  → sources: ["mcp", "clawdbot"], reach_via: ["whatsapp","telegram","discord"]
```

- sources + reach_via columns live in prod Postgres
- Legacy + v2 presence APIs both accept source + reach_via
- Multi-source merging verified (mcp + clawdbot both show active)
- TTL expiry filtering working at read time

**Phase 1 vibe-mcp: SHIPPED** — commit `b92a295`, pushed to main.

---

## Jan 31, 2026 — Phase 1 Read Side + Phase 2 DM Bridge

### Phase 1 Read Side (who.js)

- [x] `store/api.js` — `getActiveUsers()` now passes through `sources` and `reach_via` from API response
- [x] `store/api.js` — Also passes through `is_agent`, `operator`, `github` (were being stripped)
- [x] `tools/who.js` — Online list shows source badges `(via mcp, clawdbot)` and reach channels `reach: WhatsApp, Telegram`

### Phase 2 Progress (Cross-Platform DMs)

- [x] `notify.js` — `checkAndNotify()` pushes `dm_received` events to agent gateways when inbound DMs trigger notifications
  - Event includes: `from`, `to`, `body`, `reason` (mention/handshake/unread), `id`
  - This is the receive side — clawdbot can now forward /vibe DMs to Telegram/Discord/WhatsApp

### Agent Gateway Tests (31 tests, all pass)

- [x] `test/agent-gateway.test.js` — Full end-to-end test suite:
  - Registration: handle + publicKey required, stores in registry
  - AIRC verification: signed messages verified, unsigned get lower trust, wrong keys rejected, impersonation blocked
  - Event push: subscribe → pushEvent delivers to HTTP endpoint, event filtering by type, unsubscribe stops events
  - Memory: store + recall + search + list threads, all via HTTP routes
  - HTTP handler: all routes tested (register, subscribe, unsubscribe, memory, status, 404, 405)
  - AIRC crypto round-trip: keygen, sign+verify, tamper detection, wrong key rejection

### Webhook Server Wiring

- [x] `bridges/webhook-server.js` — Replaced 4 placeholder functions with real store calls:
  - `forwardToVibe()` → `store.sendMessage()` + `pushToAgents('dm', ...)`
  - `updateVibeStatus()` → `store.heartbeat()` with mood context and `source: 'bridge'`
  - `getVibeOnlineUsers()` → `store.getActiveUsers()` filtered by active status
  - `sendVibeDM()` → `store.sendMessage()` + `pushToAgents('dm', ...)`

### Phase 2 Remaining (vibe-mcp scope)

- [ ] `tools/inbox.js` — Show message source channel in inbox threads (once bridge API exists)
- [ ] Live integration test with seth-agent/clawdbot subscriber

### Ships

- Phase 1 vibe-mcp deliverable complete (source tracking in all presence calls)
- Agent gateway bridge (bridges/agent-gateway.js) — event push infra for clawdbot integration
- Agent wire protocol schema added to protocol/index.js
- Phase 1 read side: who.js shows sources + reach_via + agent fields
- Phase 2 inbound DM forwarding: dm_received events pushed to agent gateways
- Agent gateway test suite: 31 tests covering full register→subscribe→push round-trip
- Webhook server: all placeholders replaced with real store calls
