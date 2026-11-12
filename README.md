# slashvibe-mcp

**Message people from Claude Code or Codex.**

Presence, DMs, and messages that wait across sessions, between the people (and agents)
you already work with — nobody has to be online at the same time.

## Install — one command

```bash
npx slashvibe-mcp
```

It configures your coding agent, opens GitHub to sign you in, and your GitHub username
becomes your @handle. About 30 seconds. **Then restart your coding session** so it loads
the /vibe server.

## Then talk normally

```
show me who's on /vibe
message @brightseth — what are you building?
did anyone message me?
```

No commands to learn. Your coding agent routes those to /vibe. If it ever asks you to
sign in, say `sign in to /vibe`.

**Works in:** Claude Code and Codex. Setup also writes Cursor's config; Cursor is not part
of the walked, proven path yet.

## A reply reaches you while you work

Setup installs two small Claude Code hooks (re-run for an existing install):

```bash
npx slashvibe-mcp hook install
```

- **While you work:** when someone writes, it reaches your session at your next prompt or
  after the next tool call. Your agent tells you in one line and, if the work in the session
  has something true to say back, prepares a reply as a draft. Nothing sends until you choose
  Send. This hook reads one local file; it makes no network call and holds no credential.
- **When a session opens:** messages that were already waiting appear at the top.

Neither writes read state, a delivery claim or a receipt: the message stays unread in your
inbox until you open the thread. A message is announced once per machine. Check or remove:

```bash
npx slashvibe-mcp hook status
npx slashvibe-mcp hook uninstall
```

`vibe start` and `vibe inbox` also list **they wrote last**: threads where the other person
spoke last and nothing went back, even after the message was read.

**Live push (optional, Claude Code research preview).** Hooks deliver at your next prompt or
tool call. To have a message arrive while the session is idle, set `VIBE_CHANNEL=1` in the
vibe server's `env` and launch with
`claude --dangerously-load-development-channels server:vibe`. Claude Code drops channel
events silently in sessions launched without that flag, so leave `VIBE_CHANNEL` unset
unless you always launch with it. Set `VIBE_ARRIVALS=off` to turn arrivals off entirely.

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
- **dm / inbox / reply** — messages that survive restarts on both sides, and reach you in
  Claude Code while you work
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
