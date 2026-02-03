# Worktree 3: Init/Auth Stability

## Goal
First-run experience works flawlessly.

## Scope — MAY TOUCH
- `tools/init.js` — GitHub OAuth flow
- `config.js` — Config read/write
- `post-install.js` — npm post-install script

## Scope — MUST NOT TOUCH
- `presence.js` — Heartbeat loop
- `tools/dm.js` — Messaging
- `tools/inbox.js` — Message retrieval
- `tools/who.js` — Buddy list
- `store/api.js` — API client (read-only review OK)
- `games/` — All game logic
- `bridges/` — Platform integrations

## Success Criteria
- [ ] `vibe init` completes in <30s
- [ ] GitHub OAuth redirect works
- [ ] Config persists across MCP restarts
- [ ] Handles special characters in usernames
- [ ] Error messages are clear on failure
- [ ] Works on fresh install (no ~/.vibecodings)

## Test Commands
```bash
npm test
# Manual test: delete ~/.vibecodings/config.json, then run init
rm -f ~/.vibecodings/config.json
node -e "require('./tools/init').handler({}).then(console.log)"
```

## Key Files to Review
1. `tools/init.js` — Full OAuth flow
2. `config.js` — Config management
3. `store/api.js:registerSession()` — Session registration (read-only)
