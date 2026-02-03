# Vibe MCP — Codex Setup

## Quick Start

```bash
cd /Users/seth/Projects/vibe-mcp
npm install
npm test
```

## Environment

No environment variables required for local development.
The MCP server connects to `https://www.slashvibe.dev` by default.

## Test Commands

```bash
npm test              # Smoke + unit tests
npm run lint          # ESLint check
npm run typecheck     # TypeScript validation
```

## Directory Structure

```
vibe-mcp/
├── index.js          ← MCP server entry point
├── config.js         ← User identity (~/.vibecodings/config.json)
├── presence.js       ← Heartbeat loop (30s intervals)
├── tools/            ← 78 MCP tool implementations
├── store/            ← Data persistence (api.js, sqlite.js)
├── games/            ← Game logic
├── bridges/          ← Platform integrations
├── intelligence/     ← AI features
└── protocol/         ← AIRC protocol
```

## MVP-Critical Files (Do Not Break)

- `index.js` — Server entry
- `config.js` — Identity system
- `presence.js` — Heartbeat loop
- `tools/init.js` — Auth flow
- `tools/dm.js` — Messaging
- `tools/inbox.js` — Message retrieval
- `tools/who.js` — Buddy list
- `store/api.js` — Remote API client

## Success Criteria

1. `npm test` passes
2. `vibe who` returns users in <2s
3. `vibe dm @someone "test"` delivers message
4. No regressions in existing tools
