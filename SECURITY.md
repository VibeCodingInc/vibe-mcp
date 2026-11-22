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
How that choice is taken depends on the host.

**Where the host can show a box** (it declares MCP elicitation when it connects,
as Claude Code does), `vibe_send` opens one itself after all its other checks.
The box is opened by /vibe, not by the agent. It names the recipient ("To
@handle: ") and shows the opening of the exact text, all of it when the text is
short (Claude Code shows the first three lines, about 200 characters); for a
longer message the rest is in the preview, which the agent relays, and the
preview says the box will show only the first lines. Accept and Decline are the
only choices. Only Accept sends, and only if the draft is still the one in the
box. A decline, a box left
unanswered for five minutes, a session with no keyboard (`claude -p`) or any
error sends nothing and keeps the draft. A declined draft is not offered in a
box again until it has been shown again with `vibe_prepare`. One box is open at
a time. The agent never sees the box or the answer, only "sent" or "not sent".

On those hosts the box closes the gaps of the turn check below: an unrelated
prompt, or "no, don't send", no longer counts as a yes; one prompt no longer
unlocks every draft that was shown; a draft swapped after it was shown is
refused; and a wake-up the agent scheduled for itself cannot answer a box.

The box guarantees that a person at the keyboard chose to send this draft to
this person. It does not by itself prove they read every word of a long
message: past the opening, they rely on the preview the agent showed them.

What remains:

- An agent that can run shell commands as the person can still send without
  asking: `vibe-draft send <id> <rev>` sends as the person (it is the person's
  own Send for Buddy and the terminal), and the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly.
- Claude Code lets a hook answer a box (`Elicitation` and `ElicitationResult`
  hooks). Before it opens a box, `vibe_send` reads the project's
  `.claude/settings.json` and `.claude/settings.local.json` and the user's
  `settings.json`, and refuses to send while any of them has such a hook that
  could catch /vibe's box. Claude Code asks the person before an agent may
  change those files; a person who grants that write lets the agent add a hook
  between one check and the next box. Hooks configured anywhere else (managed
  policy settings, plugins, a file passed with `claude --settings`) are not
  read.
- The box shows the text wrapped for display at 72 columns, with each line
  break in the text shown as "↵". Spacing and word choice can still carry
  information the person will not notice.
- Hosts without the box fall back to the turn check, with every gap listed
  below.

## What the turn check does not cover

Where no box can be shown, `vibe_send` sends a draft only after the person has
had a turn since it was last shown in this session: a prompt they wrote,
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
