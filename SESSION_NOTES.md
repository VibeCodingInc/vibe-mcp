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

- ~~**vibe-platform** needs to accept `source` field~~ — RESOLVED: already supports it (line 355, 579-631)
- **seth-agent** needs to call `vibe_status` + `vibe_context` with `source: "clawdbot"` on session checkin/checkout

### Verification

Platform `api/presence.js` already:
1. Destructures `source` from `req.body` (line 355)
2. Validates against `['clawdbot', 'terminal', 'mcp', 'app']` (line 579)
3. Merges into `sources` JSONB via `||` operator (lines 627-631)
4. Dedicated endpoint also exists: `POST /api/presence/heartbeat` (heartbeat.js)

**Phase 1 vibe-mcp is COMPLETE and unblocked.** Next: verify live by running MCP and checking presence response includes `sources: ["mcp"]`.

### Ships

- Phase 1 vibe-mcp deliverable complete (source tracking in all presence calls)
- Agent gateway bridge (bridges/agent-gateway.js) — event push infra for clawdbot integration
- Agent wire protocol schema added to protocol/index.js
