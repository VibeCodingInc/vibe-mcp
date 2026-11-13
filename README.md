# slashvibe-mcp

**Telepathic messaging, inside your coding agent.**

You never check /vibe and you never have to write a message. Your coding agent carries a
thought out to a person, and brings a person's thought in while you work, with the answer
already prepared from what you are doing. Your part is to say yes.

## Install

```bash
npx slashvibe-mcp setup
```

It configures your coding agent, opens GitHub to sign you in (your GitHub username becomes
your @handle), and installs the hooks that let messages reach you in Claude Code. Then
restart your coding session and say `what's waiting on /vibe`.

It works from your own terminal or when your coding agent runs it for you. (The bare
`npx slashvibe-mcp` is what a coding agent launches as the server; without a terminal it
installs nothing and says so.)

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

## Who's here

When you open a session, one line tells you which of the people you know are around:

```
/vibe · here now: @sam (retry queue for webhook delivery, door open) · @ada (local or cloud)
```

That is a buddy list, on purpose. /vibe is multiplayer: the point is the people.

- It names only people you know: someone you have written to, or opened a line with. Never
  a stranger, never an agent, never someone you muted.
- It appears once, when you sit down. Nothing interrupts you to say someone came or went.
- What each person says they are working on is the line they set themselves.
- `quiet` hides it along with everything else.

```bash
npx slashvibe-mcp invisible        # be here without showing as here · undo: visible
```

Invisible, your sessions stop saying you are here, so you drop off other people's lists
within about ten minutes. You still see who is here, and messages still reach you.

## The bump

You have been stuck on something for a while. Someone you know happens to be in a session
right now, working on exactly that:

```
You have been on this backoff question for a while. @sam is here right now, working on
"retry queue for webhook delivery; picking backoff and dead-letter rules", and his door is open.

Visit "Retry Lab" · Ask @sam · Not now
```

- It only ever names people you already know. Never a stranger, however well they match.
- At most once per session, and only when you are plainly stuck.
- Visiting sends nothing. Asking shows you the message first; nothing goes without your Send.
- What you are stuck on stays on your machine. The match is made from the line the other
  person set themselves.
- `quiet` turns it off along with everything else.

## A door

Not everything is a message. If you are building something people can open, leave a door:

```bash
npx slashvibe-mcp door https://your-project.dev "Retry Lab: drag the slider"
npx slashvibe-mcp door share       # leave it with the people you know · take it down: door close
```

Now the people you left it with see it beside your name, and any of them can say
`visit @you`:

```
🚪 Visiting @sam: "Retry Lab: drag the slider, watch 10,000 webhooks back off"
   sam-retries.vercel.app · opened in your browser
   @sam is here now, working on: "retry queue for webhook delivery"

You are a visitor. Nothing was sent, and @sam was not told.
Say something to @sam · or just look around
```

- A door is not published. It goes, as one message each, only to people you have already
  written to or opened a line with. Anyone else has nothing to see.
- Only you can set or share your door, from your terminal. No tool can.
- Public https links only. A visit opens the link in the visitor's own browser; /vibe never
  fetches it, and you are not told who came.

## An open line

With someone you trust, you can go one step further. Open a line, from your terminal:

```bash
npx slashvibe-mcp trust @ada      # close it: untrust @ada · see them: lines
```

The command checks that you are signed in and that @ada exists, and tells you who that is
before it opens the line; a handle /vibe does not know opens nothing.

After that your agent may ask Ada's agent a question from your work, and answer hers from
yours, without stopping either of you. When your work is missing something she would
know, your agent asks; her agent answers from what she is actually doing; yours carries on
with the answer. She is told at her next pause what was asked and what was said. So are
you. It works unattended only when she has opened a line with you too.

This is the one place a message leaves without your approval, so the limits are enforced
by the code:

- A line opens only from that command. No tool can open one, so no message can talk an
  agent into it.
- Without a line, the unattended tools refuse and fall back to a preview for you.
- An answer goes only to the person whose message actually arrived, at most 6 an hour,
  at most 700 characters, and never anything shaped like a credential.
- Every such message says it was written by your agent and that you have not read it.
- An agent's answer is never answered by an agent.
- Each one leaves a receipt on your machine, shown on `vibe start`.

Your agent is told to give information about the work only, and to hand anything else to
you. That part is an instruction to a model, not a guarantee: open a line only with
someone you would let read over your shoulder.

## Who can reach you

Only people you know reach you while you work: someone you have written to, or someone you
opened a line with. Anyone else waits where `vibe start` lists what is waiting.

You are still told when that happens. When a session opens, one line says how many people
you have not written to are waiting, and how to ask: `what's waiting on /vibe`. It says
nothing about who they are or what they wrote, to you or to your agent, until you ask.

```bash
npx slashvibe-mcp quiet            # nothing surfaces until: unquiet
npx slashvibe-mcp mute @handle     # one person stops surfacing: unmute @handle
```

The line that says what you are working on is yours. Tell your agent ("say I'm working on
the scheduler lease") and it sets it; nothing is taken from your repository.

That includes where you are working. While a session is open it tells /vibe that you are
here, which coding agent you are in, and the line you set. It does not send your folder
path, folder name, file names or branch. One exception you turn on yourself: if you use
Vibe Buddy's list of your own sessions, set `VIBE_SESSION_BEACON=1` in the vibe server's
`env`; your sessions then send their folder path, kept for an hour where only you can
read it. For Claude Code that is `~/.claude.json`:

```json
"vibe": { "command": "npx", "args": ["-y", "slashvibe-mcp@latest"],
          "env": { "VIBE_API_URL": "https://www.slashvibe.dev", "VIBE_SESSION_BEACON": "1" } }
```

Then restart your sessions.

## The whole surface

Ten tools, for the agent (plus `vibe_init` and `vibe_token`, which only handle sign-in):

| tool | what it does |
|---|---|
| `vibe_start` | sign in; what is waiting |
| `vibe_people` | who can be reached, and what they say they are working on |
| `vibe_thread` | one conversation, in full |
| `vibe_prepare` | the agent's words, previewed; sends nothing |
| `vibe_send` | your approval of a preview, or your own exact words |
| `vibe_discard` | cancel a draft |
| `vibe_ask` | ask a person's agent, over an open line, and wait for the answer |
| `vibe_answer` | answer a person's agent, over an open line |
| `vibe_visit` | walk through a door someone left you: opens what they are building |
| `vibe_bump` | when you are stuck: is someone you know here, working on the same thing |

There is no inbox to check and no feed. There is a buddy list, deliberately a small one:
the line above, and `vibe_people` when you ask.

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

**Host.** /vibe is built for Claude Code.

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
