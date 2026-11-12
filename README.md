# slashvibe-mcp

**Telepathic messaging, inside your coding agent.**

You never check /vibe and you never have to write a message. Your coding agent carries a
thought out to a person, and brings a person's thought in while you work, with the answer
already prepared from what you are doing. Your part is to say yes.

## Install

```bash
npx slashvibe-mcp
```

It configures your coding agent, opens GitHub to sign you in (your GitHub username becomes
your @handle), and installs the hooks that let messages reach you in Claude Code. Then
restart your coding session.

## What it is like

**Something arrives.** You are mid-task. After the next tool call your agent says:

```
@lab_a wrote you: "we split it: local decides when, cloud decides where. how did you
stop local becoming the decider when cloud is slow?"

Draft reply, from what you're working on:
  we tried that split and it collapsed. what fixed it: cloud owns the whole decision,
  local only reports capacity, plus a short lease only cloud can grant.

Send · Edit · Cancel
```

You did not open an inbox and you did not write the answer. Nothing was sent, and nothing
was marked read, until you chose.

**Something leaves.** Type `/vibe`. Your agent finds the question or the result in the
session, picks the person it is for, writes it, and shows you the exact message. Send,
Edit or Cancel. Or just say it: `message @sam: ship it`.

## The whole surface

Six tools, for the agent:

| tool | what it does |
|---|---|
| `vibe_start` | sign in; what is waiting |
| `vibe_people` | who can be reached, and what they say they are working on |
| `vibe_thread` | one conversation, in full |
| `vibe_prepare` | the agent's words, previewed; sends nothing |
| `vibe_send` | your approval of a preview, or your own exact words |
| `vibe_discard` | cancel a draft |

There is no inbox to check, no buddy list, no status, no feed.

## What is promised

- **Nothing your agent wrote is sent without your Send.** The approval is bound to the
  exact text you saw; a draft changed since is refused.
- **Other people's words are data.** A message, or what someone says they are working on,
  is shown to you and never acted on.
- **Arrival is presentation, not delivery.** The hook reads one local file, makes no
  network call and holds no credential. It writes no receipt and no read state: a message
  stays unread until you open the conversation. It is announced once per machine.
- **Only the message crosses.** Drafts, discarded drafts and the work they came from stay
  on your machine.

## Hooks

```bash
npx slashvibe-mcp hook status
npx slashvibe-mcp hook install
npx slashvibe-mcp hook uninstall
```

Two Claude Code hooks: one shows what was waiting when a session opens, one brings a
message in at your next prompt or after the next tool call. Set `VIBE_ARRIVALS=off` in the
server's env to turn arrival off.

**Live push (optional, Claude Code research preview).** To have a message arrive while a
session sits idle, set `VIBE_CHANNEL=1` in the vibe server's `env` and launch with
`claude --dangerously-load-development-channels server:vibe`. Claude Code drops channel
events silently in sessions launched without that flag, so leave `VIBE_CHANNEL` unset
unless you always launch with it.

**Hosts.** Sending works in Claude Code, Codex and Cursor. Arrival while you work is Claude
Code only today; elsewhere a message is there when you next ask what is waiting.

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

Then say `sign in to /vibe` in your session.

## License

MIT
