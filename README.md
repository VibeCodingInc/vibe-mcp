# /vibe MCP Server

[![npm version](https://img.shields.io/npm/v/slashvibe-mcp.svg)](https://www.npmjs.com/package/slashvibe-mcp)
[![npm downloads](https://img.shields.io/npm/dw/slashvibe-mcp.svg)](https://www.npmjs.com/package/slashvibe-mcp)
[![CI](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/VibeCodingInc/vibe-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/slashvibe-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/slashvibe-mcp.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Smithery](https://smithery.ai/badge/slashvibe-mcp)](https://smithery.ai/server/slashvibe-mcp)

Social MCP server — DMs, presence, and discovery for AI-assisted developers. See who's building, message them, share what you shipped. Works with Claude Code, Cursor, VS Code, Windsurf, and any MCP client.

## Install

```bash
claude mcp add vibe -- npx -y slashvibe-mcp
```

<details>
<summary><strong>Other editors</strong></summary>

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "vibe": { "command": "npx", "args": ["-y", "slashvibe-mcp"] } } }
```

**VS Code** — add to `.vscode/mcp.json`:
```json
{ "servers": { "vibe": { "command": "npx", "args": ["-y", "slashvibe-mcp"] } } }
```

**Windsurf** — add to `~/.codeium/windsurf/mcp_config.json`:
```json
{ "mcpServers": { "vibe": { "command": "npx", "args": ["-y", "slashvibe-mcp"] } } }
```

**Cline** — MCP Servers > Configure > Edit JSON, add `vibe` server as above.

**Continue.dev** — create `.continue/mcpServers/vibe.json`:
```json
{ "command": "npx", "args": ["-y", "slashvibe-mcp"] }
```

**JetBrains** — Settings > Tools > AI Assistant > MCP, command `npx`, args `-y slashvibe-mcp`.
</details>

## Getting Started

```
"let's vibe"
```

That's it. Authenticates via GitHub, shows who's online, checks your inbox.

## Tools

| Tool | What it does |
|------|-------------|
| `vibe_start` | Entry point — authenticates, shows presence, checks inbox |
| `vibe_who` | See who's online and what they're building |
| `vibe_dm` | Send a direct message |
| `vibe_inbox` | Check your unread messages |
| `vibe_status` | Set your mood (shipping, thinking, debugging, etc.) |
| `vibe_ship` | Share what you shipped |
| `vibe_discover` | Find people building similar things |
| `vibe_help` | Show available commands |

## How It Works

```
Your Editor <-> /vibe MCP (stdio) <-> slashvibe.dev API <-> Other users
```

- **Presence** broadcasts via heartbeat — others see you in real time
- **Messages** are delivered through the slashvibe.dev API
- **Identity** persists via GitHub OAuth — your handle follows you across editors

## Troubleshooting

**"I installed but don't see /vibe tools"** — restart your editor after adding the MCP config.

**"Authentication failed"** — OAuth opens a browser window. If it didn't open, go to [slashvibe.dev/login](https://slashvibe.dev/login). The callback runs on `localhost:9876` — make sure that port is free.

## Development

```bash
npm install
npm test
npm run lint
```

## Contributing

We welcome contributions. See [CLA.md](./CLA.md) before submitting pull requests.

## License

MIT — see [LICENSE](./LICENSE)

## Links

- [slashvibe.dev](https://slashvibe.dev)
- [@slashvibe on X](https://twitter.com/slashvibe)

---

Built by [Slash Vibe, Inc.](https://slashvibe.dev)
