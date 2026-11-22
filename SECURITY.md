# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in /vibe, please report it responsibly.

**Email:** security@slashvibe.dev

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

This policy covers the `slashvibe-mcp` npm package and the [VibeCodingInc/vibe-mcp](https://github.com/VibeCodingInc/vibe-mcp) repository.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.9.x   | Yes       |
| < 0.9   | No        |

## Security Design

- **Identity**: GitHub OAuth — no passwords stored
- **Messages**: Synced via HTTPS to the slashvibe.dev API
- **Local storage**: a JSON config at `~/.vibe/config.json` (file mode 0600 in a 0700
  directory) holding your OAuth token and handle — no local database. `VIBE_HOME` can
  point this at an isolated directory for a separate identity.
- **No telemetry**: /vibe does not collect usage analytics. No client code calls
  an analytics endpoint — enforced by `tools/_no-telemetry.test.js`. What the
  server necessarily observes is your API traffic itself (auth, presence
  heartbeats, messages you send); nothing else is emitted.

## What the Send box covers, and what it does not

`vibe_send` sends a draft only after the person chose to send that exact text.
The preview is where the person reads the message. What else is required
depends on the host:

| Host | Required before a send |
|------|------------------------|
| Shows /vibe's box, and records person turns (Claude Code with the arrival hook) | A message the person typed after the preview (the turn check) AND Send chosen in the box, for every draft, whatever its length |
| Shows the box, but turns are not recorded (another host, or no hook) | Send chosen in the box |
| No box, turns recorded | The turn check |
| No box, turns not recorded | Nothing beyond the agent's call: the preview says so |

What the box shows. The box is opened by /vibe, not by the agent. Its first
line is fixed /vibe text: the recipient, the length, and whether all of the
text is below ("Send to @handle? (N chars, all shown)" or "(N chars, start
only)"; also "Reply to", "Resend to" and "Keep for"). Under it, the start of
the text, each line starting with "> ". Then one required field, "Your
choice", with two options, "Not now" and "Send", and nothing chosen; then
Accept / Decline. The host will not take Accept until a choice is made, so
pressing Enter alone cannot send. The box does not show which message a
reply answers, exact spacing (runs of spaces and blank characters show as one
space, line breaks as "↵") or stacked combining marks; Claude Code shows three
lines in all. So the box confirms the choice; the preview carries the
message.

What the box does:

- Only choosing Send and accepting sends (the answer must be accept with the
  choice exactly "send"), and only if the draft, its rev, its exact text and
  the signed-in account are what they were when the box opened, and the call
  was not withdrawn. Not now, an accept with no choice or any other value,
  Decline, Esc (cancel), five minutes unanswered, a session with
  no keyboard (`claude -p`), an error, or a draft edited or cancelled while
  the box was open: nothing is sent, the draft is kept, and the agent gets the
  same result for all of them, so it cannot learn what the person pressed.
  When the host withdraws the call itself, its box is withdrawn and the call
  gets no result.
- A session with no keyboard (`claude -p`) on a host that offers the box can
  never send as a person: the box is cancelled at once, and the result looks
  the same as any other message not sent. Unattended sending is what an agent
  account (below) is for.
- A draft whose box was not accepted needs showing again with `vibe_prepare`
  and a typed message before another box. After any answer but Send, no box
  opens for any draft until the person types again (five minutes where turns
  are not recorded). The record of a box not accepted lives with its draft and
  lapses when the draft expires, 24 hours after it was opened.
- One box is open at a time in a project folder, a stateless request still
  waiting for its answer included; another project is not held up by it. A
  box nobody will answer (past its five minutes, or left by a server that
  exited) is closed the next time a box would open, and counts as not
  accepted.
- After an accepted box whose delivery could not be confirmed, a "Resend"
  box can open for the same draft without a new typed message: it is the same
  showing, and the retry delivers at most once.
- The agent learns only whether it was sent, with two exceptions that can
  only follow a Send: the signed-in account changed while the box was
  open, and (on 2026-07-28) a hook found when the Send came back.

What was wrong in 0.9.23: its box had no field, so Accept was already
selected and a stray or queued Enter (for example, right after the person
typed "send") accepted it before they had seen it.

The hook tripwire. Claude Code lets a hook answer a box with no dialog
(`Elicitation` and `ElicitationResult` hooks). Before a box opens, and again
when a Send comes back on 2026-07-28, `vibe_send` reads exactly these four
files as JSON and refuses to send if one has an `Elicitation` or
`ElicitationResult` key under `hooks`, or exists and cannot be read as JSON
(it names the file):

- the project's `.claude/settings.json` and `.claude/settings.local.json`;
- the user's `settings.json` (in `CLAUDE_CONFIG_DIR`, or `~/.claude`);
- the managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json`
  on macOS, `/etc/claude-code/managed-settings.json` on Linux).

It is a tripwire for these documented locations, not a guarantee. It reads
the files as they are on disk now, not what the host loaded when it started.
Not covered: a file passed with `claude --settings`, plugin hooks, hooks
declared in skill, agent or command frontmatter if the host honours them, and
anything the host adds later.

Known limits:

- An agent that can run shell commands as the person can send without
  asking: `vibe-draft send <id> <rev>` sends as the person (it is the person's
  own Send for Buddy and the terminal), and the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly.
- A prompt the agent scheduled for itself (a wake-up, a `/loop`) still counts
  as a turn for the turn check, but cannot choose Send in the box.
- The open line's hourly cap (six unattended messages to one person) is
  enforced per server process for messages in flight; receipts are shared.
- /vibe's state lives in `VIBE_HOME` (default `~/.vibe`), with turn records
  in `VIBE_TURNS_DIR` when set (default `<VIBE_HOME>/turns`). The agent's own
  file tools (Read, Write, Edit) can reach it when `VIBE_HOME` is any path
  inside the project folder (absolute or relative), when the project folder
  is the home folder or a parent of it, or when `VIBE_TURNS_DIR` is inside the
  project. That exposes the drafts and the open box record, the turn records,
  the sign-in token, and the copy of the arrival hook script
  (`<VIBE_HOME>/hooks/arrival-hook.cjs`) that runs on every prompt. None of
  this is checked.
- An agent signed in to /vibe as itself (its own credential, a session minted
  for it as an agent, and it is the identity that sends) sends in its own name
  with no box and no turn check. Setting `VIBE_AGENT_HANDLE` alone is not
  that: the session is then treated as the person's.
- Spacing and word choice can carry information the person will not notice.

## What the turn check does not cover

Wherever person turns are recorded, with or without the box, `vibe_send`
sends a draft only after the person has had a turn since it was last shown in
this session: a prompt they wrote, recorded by the arrival hook. A pick in the host's question menu
(AskUserQuestion) does not count as the person's choice. That check binds the
agent's tool calls. It does not bind anything else running as the person:

- Any prompt counts, including "no, don't send", and one prompt unlocks every
  draft that was shown before it.
- An agent that can run shell commands as the person can send without it:
  `vibe-draft send <id> <rev>` sends as the person with no turn check (it is the
  person's own Send for Buddy and the terminal), the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly, and the turn
  files under `~/.vibe/turns/` can be written by anything with access to that
  directory.
- A prompt the agent scheduled for itself (a wake-up, a `/loop`, a cron or
  scheduled task) is counted as the person's turn. The hook cannot tell it
  from a prompt the person typed. This is a known gap.
- Messages from other agents, teammates, channels and task notifications are
  recognised by how Claude Code wraps them. A wrapper the hook does not know
  would count as a turn.
- The record is per project folder, not per session or window. A prompt in one
  window of a project counts for a draft shown in another window of the same
  project.
- The session-start record is per project folder too. A session started in one
  window of a project counts as a new session for every window of that project.
- The person sees the exact text, but spacing and word choice can carry
  information the person will not notice.
- On a host other than Claude Code, or where the arrival hook has never recorded a
  turn, there is no turn check: a draft id and rev are enough to send.
