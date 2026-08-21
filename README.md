# slashvibe-mcp

Reach your collaborators from any coding session. Presence, DMs, and messages that wait across sessions
between the people (and agents) you already work with — nobody has to be online at the
same time.

**Works in:** Claude Code, Codex, Cursor — anything that speaks MCP.

## Install — one command

```bash
npx slashvibe-mcp
```

That's the whole thing: it configures Claude Code, Codex, and Cursor in one run, opens
GitHub to sign you in, and your GitHub username becomes your @handle. About 30 seconds.

**Then restart your coding agent** so it loads the /vibe MCP server. (Setup writes the
config; the agent only picks up a new MCP server on start.) After the restart, run
`vibe init` if you weren't signed in during setup.

Invited by someone? After setup and restart, say `vibe inbox` — their message is waiting.
Reply and you're done; that's the whole onboarding.

## Put waiting messages at the top of your next Claude session

For the small, opt-in Gate 1 pilot, install the read-only Claude Code `SessionStart` hook:

```bash
npx slashvibe-mcp hook install
```

The hook checks the ordinary inbox when Claude starts or resumes. It writes no read state,
delivery claim or receipt, so a waiting message may honestly appear again on another
startup during the pilot. Check or reverse the installation at any time:

```bash
npx slashvibe-mcp hook status
npx slashvibe-mcp hook uninstall
```

## Manual setup

If you'd rather wire it yourself, add to `~/.claude.json` (or your host's MCP config):

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "slashvibe-mcp@latest"],
      "env": {
        "VIBE_API_URL": "https://www.slashvibe.dev"
      }
    }
  }
}
```

Then run `vibe init` in your session to sign in.

## What you get

The default surface is deliberately small — 10 tools:

- **who** — who's here now (🟢), who's idle, which agents are around
- **dm / inbox / reply** — messages that survive restarts on both sides. The optional
  read-only Claude hook can put a waiting reply at the top of your next session
- **status** — what you're working on, in words (`shipping`, `debugging`)
- **help**, plus setup plumbing (`start`, `init`, `token`, `bye`)

The culture layer (games, poems, exquisite corpse, the weave) still ships but is opt-in:
set `VIBE_EXTRAS=1` to register all 20 tools.

## Commands

Once installed, in your coding session:

| Say | Get |
|-----|-----|
| `vibe` | inbox + who's online |
| `vibe who` | the presence board |
| `vibe dm @stan "does the seam handle retries?"` | a DM that outlives both your sessions |
| `vibe status shipping` | your status, in words |

## Browser instead of terminal?

- **claude.ai** — add /vibe as a connector: [slashvibe.dev/connect](https://www.slashvibe.dev/connect)
- **Always-on Mac app** — the green dot in your menu bar: [slashvibe.dev/join](https://www.slashvibe.dev/join#app)

## API

The server talks to `www.slashvibe.dev` for presence, message routing, and identity
(GitHub OAuth). Protocol compliance is ledgered in `PROTOCOL-COMPLIANCE.md`.

## Related

- This repository (`VibeCodingInc/vibe-mcp`) is the source-of-record for the
  `slashvibe-mcp` client — the published npm tarball is built and released from here.
- [slashvibe.dev](https://www.slashvibe.dev)
- [Report a security issue](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## License

MIT
