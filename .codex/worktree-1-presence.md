# Worktree 1: Presence Hardening

## Goal
Ensure buddy list and heartbeat are rock-solid.

## Scope — MAY TOUCH
- `presence.js` — Heartbeat loop
- `tools/who.js` — Buddy list display
- `tools/start.js` — Session initialization
- `store/api.js` — ONLY presence-related methods:
  - `heartbeat()`
  - `getOnlineUsers()`
  - `registerSession()`

## Scope — MUST NOT TOUCH
- `tools/init.js` — Auth flow
- `tools/dm.js` — Messaging
- `tools/inbox.js` — Message retrieval
- `config.js` — Identity system
- `store/api.js` — Message methods
- `games/` — All game logic
- `bridges/` — Platform integrations

## Success Criteria
- [ ] `npm test` passes
- [ ] `vibe who` returns online users within 2s
- [ ] Heartbeat survives network blips (retry logic)
- [ ] Idle detection works (5min timeout)
- [ ] No console errors on fresh start

## Test Commands
```bash
npm test
node -e "require('./tools/who').handler({}).then(console.log)"
```

## Key Files to Review
1. `presence.js:1-85` — Full file, understand heartbeat loop
2. `tools/who.js` — Buddy list formatting
3. `store/api.js:80-150` — Presence API methods
