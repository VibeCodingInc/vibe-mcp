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
| 0.8.x   | Yes       |
| < 0.8   | No        |

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

## What the turn check does not cover

`vibe_send` sends a draft only after the person has had a turn since it was last
shown in this session: a prompt they wrote (recorded by the arrival hook), or Send
chosen in a question menu that showed that draft's exact text. That check binds
the agent's tool calls. It does not bind anything else running as the person:

- An agent that can run shell commands as the person can send without it:
  `vibe-draft send <id> <rev>` sends as the person with no turn check (it is the
  person's own Send for Buddy and the terminal), the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly, and the turn
  files under `~/.vibe/turns/` can be written by anything with access to that
  directory.
- A scheduled task or a `/loop` prompt is the person's saved words. Claude Code
  delivers it like a typed prompt and the hook cannot tell them apart, so it
  counts as a turn.
- Messages from other agents, teammates, channels and task notifications are
  recognised by how Claude Code wraps them. A wrapper the hook does not know
  would count as a turn.
- The record is per project folder, not per session or window. A prompt in one
  window of a project counts for a draft shown in another window of the same
  project.
- On a host other than Claude Code, or where the arrival hook has never recorded a
  turn, there is no turn check: a draft id and rev are enough to send.
