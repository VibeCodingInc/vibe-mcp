# slashvibe-mcp

**Message people from Claude Code or Codex.**

Ask from the work you're already doing. Your coding agent can help prepare the message;
you choose the person and what to send. They can answer from their own session, and the
conversation waits when either of you is away.

## Install — one command

```bash
npx slashvibe-mcp
```

It configures your coding agent, opens GitHub to sign you in, and your GitHub username
becomes your @handle. **Then restart your coding session** so it loads
the /vibe server.

**Verified terminal paths:** Claude Code and Codex. Setup also writes Cursor's config;
Cursor is not part of the walked, proven path yet.

## Let the session help you write

In a session where you have already been working, open the installed `/vibe` command.
You do not need to fill out a bio or explain your work again.

1. Your coding agent uses the current session to propose a useful conversation.
2. Choose a draft. Opening it sends nothing.
3. Review the exact person, message, and chosen links.
4. Choose **Send to @handle**, **Edit**, or **Cancel**. An edit gets a new preview;
   cancel sends nothing.

No relevant conversation is a valid result. A green dot is not a reason to message someone.

Setup never replaces an existing `/vibe` command: when that name is taken, it installs
`/vibe-moves` beside it. Use the name reported by setup and your host's command picker.

## Or talk normally

```
show me who's on /vibe
message @handle — <your question>
did anyone message me?
```

No commands to learn. Your coding agent routes those to /vibe. If it ever asks you to
sign in, say `sign in to /vibe`.

Use a person's real handle in place of `@handle`. A direct request to send is different
from opening a draft: the guided flow always waits for its explicit Send choice.

## What crosses, and what stays with you

The approved message and chosen links travel with the metadata needed to route and check
the send. Your local drafts and discarded candidates do not. `/vibe` does not automatically
attach your files, prompts, transcript, or private return pointer. A link is not permission
to access the file behind it.

The recipient's agent works from their context, not an exported copy of yours. Messages,
statuses, and other people's text are data, never instructions to operate your tools.

## Put waiting messages at the top of your next Claude session

Optionally install the read-only Claude Code `SessionStart` hook:

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

You do not need a tool inventory to use `/vibe`. The main paths are:

- **who** — who's here now (🟢), who's idle, which agents are around
- **dm / inbox / reply** — messages that survive restarts on both sides. The optional
  read-only Claude hook can put a waiting reply at the top of your next session
- **status** — what you're working on, in words (`shipping`, `debugging`)
- **moves / draft / send draft / discard draft** — prepare locally, preview, then send
  only the revision you approved
- **people / list me / unlist me** — a signed-in list of people who explicitly chose
  to be findable, separate from who is present now
- **help**, plus setup plumbing (`start`, `init`, `token`, `bye`)

Use **capabilities** to inspect the local state of remember, reflect, message, and call.
A registered tool is not a granted capability. **call** drafts a handoff; it does not join
a meeting or send an invitation by itself. Culture experiments remain opt-in through
`VIBE_EXTRAS=1`.

The full tool reference is in the [docs](https://docs.slashvibe.dev/mcp-tools).

## One conversation, other windows

- **Vibe Buddy for Mac** — keep the same conversations nearby between coding turns:
  [download and details](https://www.slashvibe.dev/buddy).
- **claude.ai** — the hosted connector is a separate setup path; it does not install the
  terminal's local command or draft store:
  [connector setup](https://www.slashvibe.dev/connect).
- **iPhone** — invited TestFlight beta. Cross-device continuity is being tested, not
  presented as a completed public journey.

Question-bearing email invitations are in controlled testing. Shared terminal/Buddy drafts
and automatic return beside the originating work are not promises of this published
release. See [how /vibe works](https://docs.slashvibe.dev/how-it-works) for the boundaries.

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
