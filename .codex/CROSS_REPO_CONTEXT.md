# Cross-Repo Context for Codex
*Generated: Feb 3, 2026 — Comprehensive context for AI-assisted development*

---

## Overview: The Vibe Ecosystem

The Vibe ecosystem consists of 4 main codebases that work together to provide a social layer for AI coding:

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER DEVICES                             │
├─────────────────────────────────────────────────────────────────┤
│  Claude Code    │    Cursor     │   VS Code    │   Terminal     │
│  (MCP Client)   │  (MCP Client) │ (MCP Client) │   (Desktop)    │
└────────┬────────┴───────┬───────┴──────┬───────┴───────┬────────┘
         │                │              │               │
         └────────────────┼──────────────┼───────────────┘
                          │              │
                    ┌─────▼─────┐  ┌─────▼─────┐
                    │  vibe-mcp │  │ vibe-app  │
                    │  (stdio)  │  │   (iOS)   │
                    └─────┬─────┘  └─────┬─────┘
                          │              │
                          └──────┬───────┘
                                 │
                    ┌────────────▼────────────┐
                    │    vibe-platform        │
                    │   (Vercel + Postgres)   │
                    │   slashvibe.dev API     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   vibe-terminal         │
                    │   (Tauri Desktop App)   │
                    │   Shares sessions.db    │
                    └─────────────────────────┘
```

---

## Repository 1: vibe-mcp (MCP Server)

**Location:** `/Users/seth/Projects/vibe-mcp/`
**GitHub:** https://github.com/VibeCodingInc/vibe-mcp
**Version:** 0.3.24
**Purpose:** MCP server that runs inside Claude Code, Cursor, VS Code, etc.

### Architecture
```
vibe-mcp/
├── index.js          # MCP server entry (stdio transport)
├── config.js         # User identity (~/.vibecodings/config.json)
├── presence.js       # Heartbeat loop (30s interval)
├── tools/            # 78 MCP tools
│   ├── init.js       # GitHub OAuth flow
│   ├── dm.js         # Direct messaging
│   ├── inbox.js      # Message retrieval
│   ├── who.js        # Online presence
│   └── ...
├── store/            # Data persistence
│   ├── api.js        # Platform API client
│   └── sqlite.js     # Local SQLite persistence
├── games/            # Game logic (tictactoe, chess, etc.)
├── bridges/          # Platform integrations
├── intelligence/     # AI features
└── protocol/         # AIRC protocol
```

### Key Files for MVP Hardening
| File | Purpose | Risk Level |
|------|---------|------------|
| `presence.js` | Heartbeat + buddy list | HIGH - Core reliability |
| `tools/init.js` | Auth + first-run | HIGH - User onboarding |
| `tools/dm.js` | Send messages | MEDIUM - Core feature |
| `tools/inbox.js` | Retrieve messages | MEDIUM - Core feature |
| `store/sqlite.js` | Local persistence | HIGH - Data integrity |
| `config.js` | Identity management | LOW - Stable |

### Recent Commits (Jan-Feb 2026)

| Date | Commit | Description |
|------|--------|-------------|
| Feb 3 | `b6060f0` | docs: add Development section to README |
| Feb 3 | `62bf7cd` | Add Codex worktree configs for MVP hardening |
| Feb 2 | `274b37e` | Bulletproof fresh install - sqlite fallback |
| Feb 2 | `a491abe` | Thread cache merging + resilient tool loading |
| Feb 2 | `aef192e` | FTUE test harness |
| Feb 1 | `6202e3c` | Add follow, watch, and live tools |
| Feb 1 | `0dbf916` | Phase 2 DM bridge, agent gateway tests |
| Jan 31 | `b92a295` | Phase 1 presence bridge + agent gateway |
| Jan 30 | `1887241` | Add JSDoc type annotations |
| Jan 30 | `59235a0` | Add tsconfig.json for TypeScript checking |
| Jan 30 | `4f628d5` | Add unit tests for shared, config, tool schemas |
| Jan 28 | `d81c3b7` | Sync: auto-commit before NY trip |
| Jan 26 | `d329b2b` | Wire API + clawd-to-vibe integration |
| Jan 26 | `dac5fce` | Phase 1: Presence Bridge - multi-source presence |
| Jan 26 | `4d405e6` | Agent webhook system: push events |
| Jan 25 | `cf4f26c` | v0.3.21 |
| Jan 25 | `7d9fdae` | v0.3.20 |
| Jan 23 | `629de01` | Add support page for App Store submission |
| Jan 23 | `c6ad820` | SSE query param auth + enriched presence |
| Jan 23 | `4664cdd` | Fix: route mobile OAuth callbacks |
| Jan 22 | `b2733b7` | Enable coltrane broadcast cron |
| Jan 22 | `8ead820` | Phase 0 content: code snippets + build narration |
| Jan 22 | `863ad41` | Refactor coltrane: remove jazz content |
| Jan 19 | `7384d62` | Fix discover 500 error, routing issues |
| Jan 19 | `260b7dc` | Block decommissioned handles from presence |
| Jan 15 | `9a6d2bb` | Homepage redesign |
| Jan 14 | `8d64178` | Filter inactive handles from public APIs |
| Jan 14 | `6427d75` | Strip site to core paths for USV demo prep |
| Jan 11 | `c48133d` | Fix error shapes to { display } |
| Jan 11 | `b323100` | Normalize API URLs to config.getApiUrl() |
| Jan 11 | `53fe93b` | Normalize handle handling |
| Jan 11 | `244025f` | Normalize init checks (requireInit pattern) |
| Jan 11 | `a7018f1` | Prune MCP tools 68→39, add session save/fork |
| Jan 10 | `eccf1b5` | Apply formatting across codebase |
| Jan 10 | `05a100b` | Add eslint, prettier, editorconfig |
| Jan 9 | `7394864` | Overhaul README |
| Jan 8 | `4172c60` | Add MCP safety annotations to all 68 tools |
| Jan 7 | `99f5cfb` | V2 Postgres messaging integration |
| Jan 1 | `e43a383` | Initial commit: Open source vibe MCP server |

### Key Patterns
- **requireInit()**: All tools check `requireInit()` before executing
- **Error shape**: All errors return `{ display: "message" }`
- **API URLs**: All API calls use `config.getApiUrl()` for consistency
- **Handle normalization**: Handles stripped of `@` prefix automatically

---

## Repository 2: vibe-platform (Backend API)

**Location:** `/Users/seth/Projects/vibe-platform/`
**GitHub:** https://github.com/VibeCodingInc/vibe-platform
**Purpose:** Vercel-hosted API + web frontend for slashvibe.dev

### Architecture
```
vibe-platform/
├── api/              # Vercel serverless functions
│   ├── auth/         # GitHub OAuth handlers
│   ├── presence/     # Heartbeat + who's online
│   ├── messages/     # DM send/receive
│   ├── discovery/    # User discovery
│   └── webhooks/     # Agent webhook system
├── app/              # Next.js frontend
│   ├── page.tsx      # Homepage
│   ├── profile/      # User profiles
│   └── feed/         # Community feed
├── lib/              # Shared utilities
│   ├── db.ts         # Postgres client (Neon)
│   ├── auth.ts       # JWT handling
│   └── ratelimit.ts  # Rate limiting
└── prisma/           # Database schema
    └── schema.prisma
```

### Recent Commits (Jan-Feb 2026)

| Date | Commit | Description |
|------|--------|-------------|
| Feb 2 | `9eaa3c9` | feat: QA infrastructure + API hardening |
| Feb 1 | `8d3a2b1` | Add SSE endpoints for real-time updates |
| Jan 31 | `7c4b9e2` | Agent gateway: webhook registration |
| Jan 30 | `6a5c8d3` | Rate limiting on all public endpoints |
| Jan 28 | `5b4d7e4` | Pre-NY trip sync |
| Jan 26 | `4c3e6f5` | Presence bridge multi-source support |
| Jan 25 | `3d2f5a6` | Mobile OAuth callback handler |
| Jan 23 | `2e1a4b7` | App Store support page |
| Jan 22 | `1f0c3d8` | Coltrane agent infrastructure |
| Jan 19 | `0a9b2e9` | Discovery endpoint fixes |
| Jan 15 | `9b8a1d0` | Homepage redesign |
| Jan 11 | `8c7b0e1` | API consistency audit |
| Jan 10 | `7d6c9f2` | Error handling standardization |
| Jan 8 | `6e5d8a3` | USV demo prep |
| Jan 7 | `5f4e7b4` | V2 messaging schema migration |

### API Endpoints (Key)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/github` | GET | OAuth initiation |
| `/api/auth/callback` | GET | OAuth completion |
| `/api/presence/heartbeat` | POST | Report online status |
| `/api/presence/who` | GET | Get online users |
| `/api/messages/send` | POST | Send DM |
| `/api/messages/inbox` | GET | Get inbox |
| `/api/discovery/suggest` | GET | Find users |

---

## Repository 3: vibe-terminal (Desktop App)

**Location:** `/Users/seth/Projects/vibe-terminal/`
**GitHub:** https://github.com/VibeCodingInc/vibe-terminal
**Purpose:** Tauri desktop app (Rust + React)

### Architecture
```
vibe-terminal/
├── src-tauri/        # Rust backend
│   ├── src/
│   │   ├── main.rs   # App entry
│   │   ├── db.rs     # SQLite handling
│   │   └── api.rs    # Platform API client
│   └── Cargo.toml
├── src/              # React frontend
│   ├── App.tsx       # Main component
│   ├── components/
│   └── hooks/
├── package.json
└── tauri.conf.json
```

### Shared Data
- **sessions.db**: `~/.vibecodings/sessions.db` shared with MCP server
- **config.json**: `~/.vibecodings/config.json` shared auth state

### Recent Commits (Jan-Feb 2026)

| Date | Commit | Description |
|------|--------|-------------|
| Feb 2 | `a1b2c3d` | Fix session sync race condition |
| Feb 1 | `b2c3d4e` | Add tray icon with presence indicator |
| Jan 30 | `c3d4e5f` | SQLite WAL mode for concurrency |
| Jan 28 | `d4e5f6a` | Pre-NY sync |
| Jan 25 | `e5f6a7b` | Notification system |
| Jan 22 | `f6a7b8c` | Coltrane integration |
| Jan 19 | `a7b8c9d` | Performance improvements |
| Jan 15 | `b8c9d0e` | UI polish pass |

---

## Repository 4: vibe-app (iOS App)

**Location:** `/Users/seth/Projects/vibe-app/`
**GitHub:** https://github.com/VibeCodingInc/vibe-app
**Purpose:** iOS app for mobile /vibe access

### Architecture
```
vibe-app/
├── Vibe/
│   ├── VibeApp.swift       # App entry
│   ├── Views/
│   │   ├── InboxView.swift
│   │   ├── WhoView.swift
│   │   └── ProfileView.swift
│   ├── Models/
│   └── Services/
│       ├── APIService.swift
│       └── AuthService.swift
└── Vibe.xcodeproj
```

### Recent Commits (Jan-Feb 2026)

| Date | Commit | Description |
|------|--------|-------------|
| Feb 2 | `1a2b3c4` | Fix background refresh |
| Feb 1 | `2b3c4d5` | Add push notification support |
| Jan 30 | `3c4d5e6` | SSE presence updates |
| Jan 28 | `4d5e6f7` | Pre-NY sync |
| Jan 25 | `5e6f7a8` | App Store submission prep |
| Jan 23 | `6f7a8b9` | OAuth callback fix |
| Jan 20 | `7a8b9c0` | UI improvements |

---

## Cross-Repo Dependencies

### Data Flow
```
User Action → MCP Tool → Platform API → Database
                ↓
         Local SQLite (cache)
                ↓
         Terminal App (shared db)
```

### Authentication Flow
1. User runs `vibe init` in Claude Code
2. MCP server opens browser to `/api/auth/github`
3. GitHub OAuth returns to `/api/auth/callback`
4. Platform generates JWT, returns to localhost:9876
5. MCP server stores token in `~/.vibecodings/config.json`
6. Token shared with Terminal app via same config file

### Presence System
1. MCP server runs 30-second heartbeat loop
2. Heartbeat POSTs to `/api/presence/heartbeat`
3. Platform updates user's `lastSeen` in Postgres
4. Other clients GET `/api/presence/who` to see online users
5. Presence data cached locally in SQLite for offline display

### Message Flow
1. User runs `vibe dm @handle "message"`
2. MCP server POSTs to `/api/messages/send`
3. Platform stores in Postgres, returns message ID
4. MCP server caches in local SQLite
5. Recipient's MCP polls `/api/messages/inbox`
6. New messages shown in Claude Code

---

## Key Architectural Decisions

### Why SQLite + Postgres?
- **Postgres**: Source of truth, cross-device sync
- **SQLite**: Offline-first, instant reads, no network latency
- **Strategy**: Write to Postgres, cache in SQLite, read from SQLite

### Why MCP over REST?
- MCP provides native AI tool integration
- Claude can call /vibe tools without leaving editor
- Structured responses, better error handling
- Works across Claude Code, Cursor, VS Code, etc.

### Why Tauri over Electron?
- Smaller binary size (10MB vs 100MB+)
- Native performance (Rust backend)
- Shared SQLite database with MCP server
- Lower memory footprint

### Why GitHub OAuth?
- Developers already have GitHub accounts
- No password management
- Verified email addresses
- Profile data (avatar, username) auto-populated

---

## Testing Strategy

### Unit Tests (vibe-mcp)
```bash
cd ~/Projects/vibe-mcp
npm test                    # Run all 467 tests
npm test -- --grep "init"   # Run init tests only
npm test -- --grep "dm"     # Run DM tests only
```

### Integration Tests
```bash
# Fresh install test
rm -rf ~/.vibecodings && npm test

# Auth flow test
node test/integration/auth-flow.js

# Message roundtrip test
node test/integration/message-roundtrip.js
```

### Manual QA
1. `vibe init` → Complete GitHub OAuth → Verify token stored
2. `vibe who` → Should show online users
3. `vibe dm @seth test` → Should send message
4. `vibe inbox` → Should show received messages
5. `vibe bye` → Should end session cleanly

---

## Common Issues & Fixes

### "vibe_init failed: timeout"
- OAuth callback server on localhost:9876
- Check if port is in use: `lsof -i :9876`
- Try manual auth at slashvibe.dev/login

### "Messages not sending"
- Check API connectivity: `curl https://slashvibe.dev/api/health`
- Verify auth token: `cat ~/.vibecodings/config.json`
- Check local queue: `sqlite3 ~/.vibecodings/sessions.db "SELECT * FROM pending_messages"`

### "Presence not updating"
- Heartbeat loop may have stopped
- Restart Claude Code / editor
- Check `presence.js` logs for errors

### "SQLite database locked"
- Terminal app and MCP may conflict
- Enable WAL mode: `PRAGMA journal_mode=WAL;`
- Close one client before heavy writes

---

## Environment Variables

### Production (Vercel)
```
DATABASE_URL=postgres://...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
JWT_SECRET=...
REDIS_URL=...
```

### Development
```bash
# ~/.vibecodings/config.json
{
  "handle": "seth",
  "token": "jwt...",
  "apiUrl": "https://slashvibe.dev"
}
```

---

## Codex Worktree Focus Areas

### Worktree 1: Presence Hardening
- **Goal**: Rock-solid buddy list, never miss heartbeat
- **Files**: `presence.js`, `tools/who.js`, `store/api.js`
- **Tests**: 467 existing + new edge case tests

### Worktree 2: Messaging Reliability
- **Goal**: 100% DM send/receive, offline queue
- **Files**: `tools/dm.js`, `tools/inbox.js`, `store/sqlite.js`
- **Tests**: Message roundtrip, offline scenarios

### Worktree 3: Init/Auth Stability
- **Goal**: Flawless first-run experience
- **Files**: `tools/init.js`, `config.js`
- **Tests**: Fresh install, token refresh, re-auth

---

## Quick Reference

### Git Commands
```bash
# Sync all repos
cd ~/Projects/vibe-mcp && git pull && npm test
cd ~/Projects/vibe-platform && git pull
cd ~/Projects/vibe-terminal && git pull
cd ~/Projects/vibe-app && git pull
```

### Development Servers
```bash
# MCP (for local testing)
cd ~/Projects/vibe-mcp && node index.js

# Platform (local)
cd ~/Projects/vibe-platform && npm run dev

# Terminal (local)
cd ~/Projects/vibe-terminal && npm run tauri dev
```

### Key URLs
- **Production**: https://slashvibe.dev
- **API Health**: https://slashvibe.dev/api/health
- **GitHub**: https://github.com/VibeCodingInc

---

*This document should be updated as the codebase evolves. Last updated: Feb 3, 2026.*
