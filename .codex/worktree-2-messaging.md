# Worktree 2: Messaging Reliability

## Goal
DM send/receive works 100% of the time.

## Scope — MAY TOUCH
- `tools/dm.js` — Send direct message
- `tools/inbox.js` — Retrieve messages
- `tools/open.js` — Open thread
- `store/sqlite.js` — Local message persistence
- `store/api.js` — ONLY message-related methods:
  - `sendMessage()`
  - `getMessages()`
  - `getThread()`

## Scope — MUST NOT TOUCH
- `presence.js` — Heartbeat loop
- `tools/init.js` — Auth flow
- `tools/who.js` — Buddy list
- `config.js` — Identity system
- `games/` — All game logic
- `bridges/` — Platform integrations

## Success Criteria
- [ ] Send DM → recipient receives within 5s
- [ ] Offline messages delivered on reconnect
- [ ] Message deduplication works (no duplicates)
- [ ] Thread history persists locally in SQLite
- [ ] Large messages (>1KB) handled correctly

## Test Commands
```bash
npm test
node -e "require('./tools/dm').handler({handle:'@echo', message:'test'}).then(console.log)"
node -e "require('./tools/inbox').handler({}).then(console.log)"
```

## Key Files to Review
1. `tools/dm.js:1-80` — Message send logic
2. `tools/inbox.js` — Inbox retrieval
3. `store/sqlite.js` — Local persistence layer
4. `store/api.js:150-250` — Message API methods
