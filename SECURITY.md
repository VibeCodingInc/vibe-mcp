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
The rule: the person must have had the chance to see every word that will be
sent, either in /vibe's confirmation box itself, or in the preview followed by
a message they typed.

**Where the host can show a box** (it declares MCP form elicitation: at
`initialize` on protocol 2025-06-18 or 2025-11-25, or in the request itself on
2026-07-28), `vibe_send` opens one, and sends only if the person presses
Accept:

- If the whole message fits in the box, Accept alone sends it. "Tell oren the
  TTL is 7 min" is one gesture: the box shows all of it.
- If it does not fit, the person must also have typed a message after the
  preview was shown, in this session (the turn check below), before the box
  opens.
- Where the turn check is unavailable (a host that is not Claude Code, or
  Claude Code where no turn was ever recorded because the arrival hook is not
  installed), the box alone decides, whatever the length.

What the box shows and does:

- The box is opened by /vibe, not by the agent. Its first line is fixed text
  from /vibe naming the recipient, the length, and whether all of the message
  is shown ("Send to @handle now? (N chars, all shown)" or "(N chars, only
  start shown)"; "Reply to", "again" and "Keep for @handle till they join?"
  variants). The lines under it are the text, each starting with "> ", so the
  text cannot pass for /vibe's or the host's own words. Runs of spaces and
  blank characters show as one space and each line break as "↵", for display
  only. Claude Code shows three lines in all, so about 140 characters of text
  fit.
- Accept sends only if the draft, its rev, its exact text and the signed-in
  account are what they were when the box opened, and the call was not
  withdrawn. Decline, Esc (cancel), a box left unanswered for five minutes, a
  session with no keyboard (`claude -p`, where the box is cancelled at once)
  or an error sends nothing and keeps the draft, and the agent gets the same
  result for all of them. When the host withdraws the call itself, its box is
  withdrawn, nothing is sent, and the call gets no result at all.
- No nagging: once a box has been opened for a draft and not accepted, that
  draft needs showing again with `vibe_prepare` and a message typed by the
  person before another box. After any answer but Accept, no box opens for any
  draft until the person types again (where no turn is ever recorded, for five
  minutes). At most three boxes open per person turn (where no turn is ever
  recorded, three per server process). One box is open at a time.
- The agent learns only whether it was sent. The box, its wording and the
  answer are not in the tool result.

The box guarantees that a person at the keyboard chose to send this draft to
this person. When the whole message is in the box, they saw every word there.
When only the start is, they rely on the preview the agent showed them, and the
box says so. In particular, an edit the person asked for that the agent did not
make can be noticed in the box only when the whole message is shown there;
otherwise only in the preview.

On hosts that show it, the box closes these gaps of the turn check: an
unrelated prompt, or "no, don't send", is not a yes; one prompt does not unlock
every draft that was shown; a wake-up the agent scheduled for itself cannot
press Accept.

**Where the host cannot show a box**, the turn check alone applies, with every
gap listed below, and the preview says: "This app cannot show /vibe's
confirmation box, so sending relies on your typed reply."

What remains:

- An agent that can run shell commands as the person can still send without
  asking: `vibe-draft send <id> <rev>` sends as the person (it is the person's
  own Send for Buddy and the terminal), and the sign-in token in
  `~/.vibe/config.json` (or `auth.json`) can call the API directly.
- Claude Code lets a hook answer a box with no dialog (`Elicitation` and
  `ElicitationResult` hooks). Before it opens a box, and again when an Accept
  comes back on 2026-07-28, `vibe_send` reads:
  - `.claude/settings.json` and `.claude/settings.local.json` in the project
    folder and in every parent folder up to the home folder (or the root);
  - the user's `settings.json` (in `CLAUDE_CONFIG_DIR`, or `~/.claude`);
  - the managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json`
    on macOS, `/etc/claude-code/managed-settings.json` on Linux);
  - `hooks/hooks.json` under the config folder's `plugins/` (four levels, 200
    folders, links not followed);
  - the frontmatter of `.claude/skills/*/SKILL.md`, `.claude/agents/*.md` and
    `.claude/commands/*.md` in the project and the config folder (200 files,
    64 KB each, real paths inside the folder only).

  It refuses to send while any of them has any Elicitation or
  ElicitationResult hook, whatever it matches, or cannot be parsed and
  mentions elicitation. A file that exists but cannot be read is skipped. This
  list may not match every place the host loads hooks from: whether the host
  honours a hook in skill, agent or command frontmatter, and whether it
  protects those files from an agent's writes, is not verified, and a file
  passed with `claude --settings` is not read. Claude Code asks the person
  before an agent may change its settings files; a person who grants that
  write lets the agent add a hook between one check and the next box.
- Spacing and word choice can still carry information the person will not
  notice.
- An agent signed in to /vibe as itself (its own credential, a session minted
  for it as an agent, and it is the identity that sends) sends in its own name
  with no box and no turn check: there is no person whose words these are.
  Setting `VIBE_AGENT_HANDLE` is not enough: without that session, the
  session is treated as the person's, with every check above.
- `VIBE_HOME` set to a relative path that resolves inside the project folder
  puts the drafts, the turn records and the sign-in token where the agent's
  own file tools can reach them. That is not checked.

## What the turn check does not cover

Where a box cannot be shown, and where the box cannot show the whole message,
`vibe_send` sends a draft only after the person has had a turn since it was
last shown in this session: a prompt they wrote, recorded by the arrival hook. A pick in the host's question menu
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
