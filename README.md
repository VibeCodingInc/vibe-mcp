# /vibe MCP Server

[![npm version](https://img.shields.io/npm/v/slashvibe-mcp.svg)](https://www.npmjs.com/package/slashvibe-mcp)
[![license](https://img.shields.io/npm/l/slashvibe-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/slashvibe-mcp.svg)](https://nodejs.org)
[![CI](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml)

The social layer for AI coding. DMs, presence, discovery, and games between developers — without leaving your editor.

Works with Claude Code, Cursor, VS Code, Windsurf, Cline, Continue.dev, JetBrains, and any MCP-compatible client.

## Install

Add to your MCP config and restart your editor:

<details open>
<summary><strong>Claude Code</strong></summary>

Add to `~/.claude.json`:
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

Or via CLI:
```bash
claude mcp add vibe -- npx -y slashvibe-mcp
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

Or add to your `settings.json`:
```json
{
  "mcp": {
    "servers": {
      "vibe": {
        "command": "npx",
        "args": ["-y", "slashvibe-mcp"]
      }
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
<summary><strong>Cline (VS Code)</strong></summary>

Open Cline > MCP Servers icon > Configure > Edit JSON, then add:
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
<summary><strong>Continue.dev</strong></summary>

Create `.continue/mcpServers/vibe.json`:
```json
{
  "command": "npx",
  "args": ["-y", "slashvibe-mcp"]
}
```
</details>

<details>
<summary><strong>JetBrains (IntelliJ, WebStorm, etc.)</strong></summary>

Go to **Settings > Tools > AI Assistant > Model Context Protocol (MCP)** and add a new server:
- **Command:** `npx`
- **Arguments:** `-y slashvibe-mcp`

Or import from your Claude Code config if you already have one.
</details>

## Getting Started

Once installed, tell Claude:

```
"let's vibe"
```

That's it. Claude will authenticate you via GitHub, show who's online, and check your inbox.

If you prefer step-by-step:

1. **Authenticate** — `vibe init` opens GitHub OAuth in your browser. Takes 30 seconds.
2. **See who's around** — `vibe who` shows online builders and what they're working on.
3. **Check messages** — `vibe inbox` shows unread DMs.
4. **Send your first message** — `vibe dm @seth hey, just set up /vibe!`

## Tools (39)

### Core — Identity & Session

| Tool | What it does |
|------|-------------|
| `vibe_start` | Entry point — authenticates, shows who's online, checks inbox |
| `vibe_init` | Set up your identity via GitHub OAuth |
| `vibe_bye` | End your session |

### Core — Messaging

| Tool | What it does |
|------|-------------|
| `vibe_dm` | Send a direct message |
| `vibe_inbox` | Check your unread messages |
| `vibe_ping` | Send a quick wave to someone |
| `vibe_react` | React to a message |
| `vibe_open` | Open a conversation thread with someone |

### Presence

| Tool | What it does |
|------|-------------|
| `vibe_who` | See who's online and what they're building |
| `vibe_status` | Set your mood or what you're working on |
| `vibe_away` | Set yourself away |
| `vibe_back` | Return from away |

### Creative — Ship & Share

| Tool | What it does |
|------|-------------|
| `vibe_ship` | Share with the community: ship (default), idea, or request via `type` param |
| `vibe_session_save` | Save your coding session — makes it replayable, discoverable, and forkable |
| `vibe_session_fork` | Fork an existing session to build on it |
| `vibe_feed` | See what people are shipping and sharing |
| `vibe_context` | Share what you're working on |

### Discovery

| Tool | What it does |
|------|-------------|
| `vibe_discover` | Find people, skills, and partners. Subcommands: suggest, search, interests, active, skills, partner |
| `vibe_invite` | Generate an invite link |

### Memory

| Tool | What it does |
|------|-------------|
| `vibe_remember` | Save a note about someone for next time |
| `vibe_recall` | Pull up everything you know about someone |
| `vibe_forget` | Delete a memory |

### Games — 27 Multiplayer & Solo Games

| Tool | What it does |
|------|-------------|
| `vibe_game` | All games via one tool. Multiplayer (tictactoe, chess), solo (hangman, rps, memory), party (twotruths, werewolf), AI (tictactoe-ai), collaborative (drawing, crossword, wordassociation, wordchain, storybuilder) |

### Artifacts

| Tool | What it does |
|------|-------------|
| `vibe_create_artifact` | Create a shareable guide, workspace, or learning |
| `vibe_view_artifact` | View shared artifacts |

### File Coordination

| Tool | What it does |
|------|-------------|
| `vibe_reserve` | Reserve files for editing |
| `vibe_release` | Release file reservations |
| `vibe_reservations` | List active file reservations |

### Infrastructure

| Tool | What it does |
|------|-------------|
| `vibe_handoff` | Create an AIRC context handoff for another tool |
| `vibe_report` | Report issues or inappropriate behavior |
| `vibe_suggest_tags` | Get tag suggestions for your profile |

### Diagnostics

| Tool | What it does |
|------|-------------|
| `vibe_help` | Show available commands |
| `vibe_doctor` | Full health check — API, auth, storage, presence |
| `vibe_update` | Check for and apply updates |

### Settings

| Tool | What it does |
|------|-------------|
| `vibe_settings` | Configure preferences |
| `vibe_notifications` | Configure notification channels |
| `vibe_presence_agent` | Background presence agent |
| `vibe_mute` | Mute a user |
| `vibe_summarize` | Summarize session context |

## How It Works

/vibe is an MCP server that connects your editor to [slashvibe.dev](https://slashvibe.dev). Messages sync via a Postgres backend with local SQLite persistence for offline-first speed. Everyone using /vibe is on the same network — regardless of which editor they use.

```
Your Editor ←→ /vibe MCP (stdio) ←→ slashvibe.dev API ←→ Other users
                     ↕
               Local SQLite DB
               (~/.vibecodings/sessions.db)
```

- **Identity** persists via GitHub OAuth — your handle follows you across sessions
- **Messages** are stored locally first, then synced to the server (optimistic send)
- **Presence** broadcasts via heartbeat — others see you in real time
- **Memory** is local — notes you save about people stay on your machine

## Troubleshooting

**"I installed but don't see /vibe tools in Claude Code"**
- Make sure you restarted Claude Code after adding the MCP config
- Check your config file: `~/.claude.json` or `~/.config/claude-code/mcp.json`
- Run `vibe doctor` to diagnose issues

**"Authentication failed or timed out"**
- The OAuth flow opens a browser window — if it didn't open, go to [slashvibe.dev/login](https://slashvibe.dev/login) manually
- The auth callback runs on `localhost:9876` — make sure that port is free
- You have 2 minutes to complete the GitHub login

**"Messages aren't sending"**
- Run `vibe doctor` to check API connectivity
- Check your internet connection
- Messages are saved locally even if the API is down — they'll sync when you reconnect

**"I see 'Unknown tool' errors"**
- You may be running an older version. Run `vibe update` or reinstall: `npm install -g slashvibe-mcp`

## Configuration

Config lives at `~/.vibecodings/config.json` (primary) or `~/.vibe/config.json` (legacy fallback).

Local message database: `~/.vibecodings/sessions.db` (SQLite, shared with Vibe Terminal desktop app).

## Contributing

We welcome contributions. Please read our [Contributor License Agreement](./CLA.md) before submitting pull requests.

- Report bugs via [GitHub Issues](https://github.com/VibeCodingInc/vibe-mcp/issues)
- Propose features via [Discussions](https://github.com/VibeCodingInc/vibe-mcp/discussions)

## License

MIT — see [LICENSE](./LICENSE)

## Links

- [slashvibe.dev](https://slashvibe.dev) — The platform
- [Vibe Terminal](https://github.com/VibeCodingInc/vibe-terminal) — Desktop app
- [@slashvibe on X](https://twitter.com/slashvibe) — Updates

---

Built by [Slash Vibe, Inc.](https://slashvibe.dev)
