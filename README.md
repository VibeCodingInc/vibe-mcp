# /vibe MCP Server

The social layer for Claude Code. DMs, presence, discovery, and games between AI developers — without leaving the terminal.

## Install

Add to your Claude Code MCP config (`~/.claude.json` or `~/.config/claude-code/mcp.json`):

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

Then restart Claude Code.

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

## Tools

### Core — Messaging & Presence

| Tool | What it does |
|------|-------------|
| `vibe_start` | Entry point — authenticates, shows who's online, checks inbox |
| `vibe_init` | Set up your identity via GitHub OAuth |
| `vibe_who` | See who's online and what they're building |
| `vibe_dm` | Send a direct message |
| `vibe_inbox` | Check your unread messages |
| `vibe_open` | Open a conversation thread with someone |
| `vibe_ping` | Send a quick wave to someone |
| `vibe_react` | React to a message |
| `vibe_status` | Set your mood or what you're working on |
| `vibe_away` / `vibe_back` | Set yourself away or return |
| `vibe_bye` | End your session |

### Discovery — Find Your People

| Tool | What it does |
|------|-------------|
| `vibe_discover` | Find builders by interests, projects, or activity |
| `vibe_suggest_tags` | Get tag suggestions for your profile |
| `vibe_skills_exchange` | Browse and offer skills |
| `vibe_workshop_buddy` | Find a learning partner |
| `vibe_invite` | Generate an invite link |

### Creative — Ship & Share

| Tool | What it does |
|------|-------------|
| `vibe_ship` | Announce what you shipped |
| `vibe_idea` | Share an idea with the community |
| `vibe_request` | Ask the community for help |
| `vibe_feed` | See what people are shipping and sharing |
| `vibe_create_artifact` | Create a shareable guide, workspace, or learning |
| `vibe_view_artifact` | View shared artifacts |

### Memory — Context That Persists

| Tool | What it does |
|------|-------------|
| `vibe_remember` | Save a note about someone for next time |
| `vibe_recall` | Pull up everything you know about someone |
| `vibe_forget` | Delete a memory |
| `vibe_handoff` | Create an AIRC context handoff for another tool |

### Games — 27 Multiplayer & Solo Games

| Tool | What it does |
|------|-------------|
| `vibe_game` | Start a multiplayer game with someone |
| `vibe_solo_game` | Play a solo game (riddles, hangman, number guess) |
| `vibe_tictactoe` | Challenge someone to tic-tac-toe |
| `vibe_crossword` | Collaborative crossword puzzle |
| `vibe_drawing` | Collaborative ASCII drawing |
| `vibe_party_game` | Start a party game for 3+ players |

### Bridges — Cross-Platform Social

| Tool | What it does |
|------|-------------|
| `vibe_x_mentions` | Check your X/Twitter mentions |
| `vibe_x_reply` | Reply on X from the terminal |
| `vibe_social_inbox` | Unified inbox across platforms |
| `vibe_social_post` | Post to multiple networks at once |

### Diagnostics

| Tool | What it does |
|------|-------------|
| `vibe_doctor` | Full health check — API, auth, storage, presence |
| `vibe_test` | Quick connection and identity test |
| `vibe_help` | Show available commands |
| `vibe_update` | Check for and apply updates |
| `vibe_settings` | Configure preferences |

## How It Works

/vibe is an MCP server that connects Claude Code to [slashvibe.dev](https://slashvibe.dev). Your messages sync via a Postgres backend with local SQLite persistence for offline-first speed.

```
Claude Code ←→ /vibe MCP (stdio) ←→ slashvibe.dev API ←→ Other users
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
