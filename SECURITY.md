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
How that choice is checked depends on the host.

**Everywhere a tool call sends**, the turn check below applies first: the
person must have typed a message after the draft was last shown, in this
session.

**Where the host can also show a box** (it declares MCP form elicitation:
at `initialize` on protocol 2025-06-18 or 2025-11-25, or in the request itself
on 2026-07-28), `vibe_send` then opens one, and sends only if the person
presses Accept. Both are required: the typed message and the Accept.

- The box is opened by /vibe, not by the agent. Its first line is fixed text
  from /vibe naming the recipient and the length ("Send to @handle now? (N
  characters)", or "Send this reply to …", or "Keep this for @handle until
  they join /vibe?"). The lines under it show the opening of the exact text,
  wrapped for display, with each line break shown as "↵"; all of it when the
  text is short (Claude Code shows three lines in all, about 140 characters of
  text). For a longer message the rest is only in the preview, which the agent
  relays, and the preview says the box shows only the first lines.
- Accept sends only if the draft, its rev, its exact text and the signed-in
  account are all what they were when the box opened, and the call was not
  cancelled. Decline, Esc (cancel), a box left unanswered for five minutes, a
  session with no keyboard (`claude -p`, where the box is cancelled at once),
  the host withdrawing the call, or any error: nothing is sent and the draft
  is kept. All of these give the agent the same result.
- One box per showing: once a box has been opened for a draft, whatever the
  answer, another box for it needs the draft shown again with `vibe_prepare`
  and a message typed by the person after that. An agent cannot open box after
  box, or re-show the draft by itself and try again. One box is open at a time.
- The agent learns only whether it was sent. The box, its wording and the
  answer are not in the tool result.

The box guarantees that a person at the keyboard chose to send this draft to
this person. It does not by itself prove they read every word of a long
message: past the opening, they rely on the preview the agent showed them.

On hosts that show it, the box closes these gaps of the turn check: an
unrelated prompt, or "no, don't send", is not a yes; one prompt does not
unlock every draft that was shown; a wake-up the agent scheduled for itself
cannot press Accept.

What remains:

- An agent that can run shell commands as the person can still send without
  asking: `vibe-draft send <id> <rev>` sends as the person (it is the person's
  own Send for Buddy and the terminal), and the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly.
- Claude Code lets a hook answer a box with no dialog (`Elicitation` and
  `ElicitationResult` hooks). Before it opens a box, `vibe_send` reads the
  project's `.claude/settings.json` and `.claude/settings.local.json` and the
  user's `settings.json` (in `CLAUDE_CONFIG_DIR`, or `~/.claude`), and refuses
  to send while any of them has any Elicitation or ElicitationResult hook,
  whatever it matches, or cannot be parsed and mentions elicitation. The scan
  cannot see hooks configured anywhere else: managed (enterprise) policy
  settings, plugins, or a file passed with `claude --settings`. Claude Code
  asks the person before an agent may change its settings files; a person who
  grants that write lets the agent add a hook between one check and the next
  box.
- Spacing and word choice can still carry information the person will not
  notice.
- Hosts without the box have the turn check alone, with every gap listed
  below.
- An agent signed in to /vibe as itself (its own credential, a session minted
  for it as an agent, and it is the identity that sends) sends in its own name
  with no box and no turn check: there is no person whose words these are.
  Setting `VIBE_AGENT_HANDLE` is not enough: without that session, the
  session is treated as the person's, with every check above.

## What the turn check does not cover

On every host, `vibe_send` sends a draft only after the person has had a turn
since it was last shown in this session (and, where a box can be shown, an
Accept in it as well): a prompt they wrote,
recorded by the arrival hook. A pick in the host's question menu
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
