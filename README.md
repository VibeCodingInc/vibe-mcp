# /vibe MCP Server

The social layer for Claude Code. DMs, presence, and connection between AI developers.

## What is /vibe?

/vibe brings social connection to the terminal. While you're building with Claude Code, /vibe lets you:

- **See who's online** - Know when other developers are in flow
- **Send DMs** - Message fellow builders without leaving your terminal
- **Share your presence** - Let others know what you're working on
- **Build reputation** - Your sessions become proof of work

## Installation

```bash
npx slashvibe-mcp
```

Or add to your Claude Code MCP settings (`~/.claude.json`):

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

## Quick Start

1. Install the MCP server
2. Authenticate: `vibe_auth` tool will guide you
3. Check who's online: `vibe_presence`
4. Send a message: `vibe_dm`

## Available Tools

| Tool | Description |
|------|-------------|
| `vibe_auth` | Authenticate with slashvibe.dev |
| `vibe_presence` | See who's online now |
| `vibe_dm` | Send a direct message |
| `vibe_inbox` | Check your messages |
| `vibe_ship` | Announce what you shipped |
| `vibe_idea` | Share an idea with the community |
| `vibe_discover` | Find interesting builders |
| `vibe_remember` | Save context about a connection |
| `vibe_recall` | Recall memories about someone |

## The Platform

This MCP server connects to [slashvibe.dev](https://slashvibe.dev), where:

- Your identity persists across sessions
- Your work builds reputation over time
- The community grows through genuine connection

## Philosophy

We believe AI development should be social, not solitary. The terminal is where real work happens - decisions, debugging, breakthroughs. /vibe makes that visible and connectable.

**Empathy. Collaboration. Shared value creation.**

## Contributing

We welcome contributions! Please read our [Contributor License Agreement](./CLA.md) before submitting pull requests.

- Report bugs via [GitHub Issues](https://github.com/VibeCodingInc/vibe-mcp/issues)
- Propose features via [Discussions](https://github.com/VibeCodingInc/vibe-mcp/discussions)
- Submit PRs for review

## License

MIT - see [LICENSE](./LICENSE)

## Links

- [slashvibe.dev](https://slashvibe.dev) - The platform
- [Twitter](https://twitter.com/slashvibe) - Updates

---

Built with obsession by [Slash Vibe, Inc.](https://slashvibe.dev)
