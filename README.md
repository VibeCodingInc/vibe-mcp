# /vibe MCP Server

[![npm version](https://img.shields.io/npm/v/slashvibe-mcp.svg)](https://www.npmjs.com/package/slashvibe-mcp)
[![npm downloads](https://img.shields.io/npm/dw/slashvibe-mcp.svg)](https://www.npmjs.com/package/slashvibe-mcp)
[![CI](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/slashvibe-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/slashvibe-mcp.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Smithery](https://smithery.ai/badge/slashvibe-mcp)](https://smithery.ai/server/slashvibe-mcp)

The presence layer for AI-mediated work. See who's building, message them, share context — without leaving your editor.

**New:** Live buddy list widget renders inline in Claude Desktop and VS Code via [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps).

Works with Claude Code, Cursor, VS Code, Windsurf, Cline, Continue.dev, JetBrains, and any MCP-compatible client.

## Install

**Quick install** — auto-detects your editors and configures all of them:

```bash
npx slashvibe-mcp install
```

**Or** add to your MCP config manually and restart your editor:

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add vibe -- npx -y slashvibe-mcp
```

Or add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "slashvibe-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "slashvibe-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Add to `.vscode/mcp.json` in your workspace:
```json
{
  "servers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "slashvibe-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "slashvibe-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cline / Continue.dev / JetBrains</strong></summary>

**Cline:** Open MCP Servers > Configure > Edit JSON, add `vibe` server as above.

**Continue.dev:** Create `.continue/mcpServers/vibe.json`:
```json
{
  "command": "npx",
  "args": ["-y", "slashvibe-mcp"]
}
```

**JetBrains:** Settings > Tools > AI Assistant > MCP, add server with command `npx` and args `-y slashvibe-mcp`.
</details>

## Getting Started

Once installed, tell your AI:

```
"let's vibe"
```

That's it. It authenticates you via GitHub, shows who's online, and checks your inbox.

Step-by-step:

1. **Authenticate** — `vibe init` opens GitHub OAuth. Takes 30 seconds.
2. **See who's around** — `vibe who` shows online builders and what they're working on.
3. **Check messages** — `vibe inbox` shows unread DMs.
4. **Send a message** — `vibe dm @seth hey, just set up /vibe!`

## Tools

### Presence

| Tool | What it does |
|------|-------------|
| `vibe_who` | See who's online and what they're building |
| `vibe_status` | Set your mood or what you're working on |
| `vibe_away` | Set yourself away with a message |
| `vibe_back` | Return from away |
| `vibe_presence_agent` | Background presence agent |

### Messaging

| Tool | What it does |
|------|-------------|
| `vibe_dm` | Send a direct message |
| `vibe_inbox` | Check your unread messages |
| `vibe_ping` | Send a quick wave to someone |
| `vibe_react` | React to a message |
| `vibe_open` | Open a conversation thread |
| `vibe_follow` | Follow someone for notifications |
| `vibe_unfollow` | Unfollow someone |

### Sessions & Context

| Tool | What it does |
|------|-------------|
| `vibe_start` | Entry point — authenticates, shows presence, checks inbox |
| `vibe_bye` | End your session |
| `vibe_context` | Share what you're working on |
| `vibe_summarize` | Generate session summary from local journal |
| `vibe_session_resume` | Resume context from a prior session |
| `vibe_session_save` | Save your session — replayable, discoverable, forkable |
| `vibe_session_fork` | Fork an existing session to build on it |
| `vibe_handoff` | Hand off a task with full context |

### Discovery & Memory

| Tool | What it does |
|------|-------------|
| `vibe_discover` | Find people, skills, and collaborators |
| `vibe_invite` | Generate an invite link |
| `vibe_remember` | Save a note about someone |
| `vibe_recall` | Pull up everything you know about someone |
| `vibe_forget` | Delete a memory |

### Collaboration

| Tool | What it does |
|------|-------------|
| `vibe_ship` | Share what you shipped, an idea, or a request |
| `vibe_feed` | See what people are shipping |
| `vibe_reserve` | Reserve files for editing (prevents conflicts) |
| `vibe_release` | Release file reservations |
| `vibe_reservations` | List active reservations |
| `vibe_create_artifact` | Create a shareable guide or workspace |
| `vibe_view_artifact` | View shared artifacts |

### Infrastructure

| Tool | What it does |
|------|-------------|
| `vibe_init` | Set up identity via GitHub OAuth |
| `vibe_help` | Show available commands |
| `vibe_doctor` | Health check — API, auth, storage, presence |
| `vibe_update` | Check for and apply updates |
| `vibe_settings` | Configure preferences |
| `vibe_notifications` | Configure notification channels |
| `vibe_mute` | Mute a user |
| `vibe_report` | Report issues or inappropriate behavior |

## How It Works

```
Your Editor ←→ /vibe MCP (stdio) ←→ slashvibe.dev API ←→ Other users
                     ↕
               Local SQLite DB
               (~/.vibecodings/sessions.db)
```

- **Presence** broadcasts via heartbeat — others see you in real time
- **Messages** are stored locally first, then synced (optimistic send)
- **Sessions** are journaled to SQLite — durable, resumable, summarizable
- **Identity** persists via GitHub OAuth — your handle follows you across editors and machines
- **Memory** is local — notes about people stay on your machine

## Troubleshooting

**"I installed but don't see /vibe tools"**
- Restart your editor after adding the MCP config
- Run `vibe doctor` to diagnose

**"Authentication failed or timed out"**
- OAuth opens a browser window — if it didn't, go to [slashvibe.dev/login](https://slashvibe.dev/login)
- The callback runs on `localhost:9876` — make sure that port is free

**"Messages aren't sending"**
- Run `vibe doctor` to check API connectivity
- Messages save locally even when offline — they sync on reconnect

## Configuration

Config: `~/.vibecodings/config.json` (primary) or `~/.vibe/config.json` (legacy fallback).

Database: `~/.vibecodings/sessions.db` (SQLite, WAL mode).

## Development

```bash
npm install
npm test              # All tests
npm run lint          # ESLint
npm run typecheck     # TypeScript validation
```

```
vibe-mcp/
├── index.js          # MCP server entry + CLI
├── config.js         # User identity
├── presence.js       # Heartbeat loop (30s)
├── analytics.js      # Anonymous usage tracking
├── tools/            # MCP tools
├── store/            # Persistence (api.js, sqlite.js, sessions.js)
├── bridges/          # Platform integrations (Discord, Telegram, etc.)
├── intelligence/     # Ambient signals (serendipity, proactive discovery)
└── protocol/         # AIRC protocol
```

## Contributing

We welcome contributions. See [CLA.md](./CLA.md) before submitting pull requests.

- [GitHub Issues](https://github.com/VibeCodingInc/vibe-mcp/issues) — Bug reports
- [Discussions](https://github.com/VibeCodingInc/vibe-mcp/discussions) — Feature proposals

## License

MIT — see [LICENSE](./LICENSE)

## Links

- [slashvibe.dev](https://slashvibe.dev) — Platform
- [Vibe Terminal](https://github.com/VibeCodingInc/vibe-terminal) — Desktop app
- [@slashvibe on X](https://twitter.com/slashvibe) — Updates

---

Built by [Slash Vibe, Inc.](https://slashvibe.dev)
