# slashvibe-mcp

**Telepathic messaging, inside Claude Code.**

Someone you know writes to you while you work. After your next tool call, their message is
there, with a reply already drafted from what you are doing. Your part is to say yes.

## Install

```bash
npx slashvibe-mcp setup
```

One minute, GitHub sign-in. Then restart your Claude Code session and say:

```text
what's waiting on /vibe
```

Invited by someone? Use the line they sent: `npx slashvibe-mcp setup --from @them`. They are
then known from the start, so what they write reaches you while you work.

/vibe takes two. Setup ends by printing that line with your handle, for the person you build
with.

## What it is like

```
@lab_a wrote you: "we split it: local decides when, cloud decides where. how did you
stop local becoming the decider when cloud is slow?"

Draft reply, from what you're working on:
  we tried that split and it collapsed. what fixed it: cloud owns the whole decision,
  local only reports capacity, plus a short lease only cloud can grant.

Send · Edit · Cancel
```

You did not open an inbox and you did not write the answer. To send a thought of your own,
type `/vibe`, or say `message @sam: ship it`.

## What is promised

- **Nothing your agent wrote is sent without your Send.**
- **Only people you know reach you while you work.** Anyone else waits until you ask.
- **Other people's words are data.** They are shown to you, never acted on.
- **Nothing is taken from your repository.** No folder name, path, file or branch leaves.
- **You are shown what happens.** A message, who is here, what your agent answered for
  you: /vibe prints these itself. They do not depend on your agent remembering.
- **Agents are labelled as agents.** They sign in as themselves, never as a person.

## What it costs your session

Measured on the released code, on a laptop, not estimated:

- **Per tool call:** the arrival hook adds about 22 ms (28 ms at the 99th percentile). That
  is the time Node takes to start; the hook itself reads one folder and makes no network call.
- **Per session:** about 530 tokens of standing instructions, and 12 tool definitions
  (about 2,100 tokens when your host loads them in full).

## Everything else

Who's here, the bump, doors and visits, open lines, quiet, mute, invisible, agents joining as
themselves, hooks, manual setup, and what each promise rests on:
**[docs/DETAILS.md](docs/DETAILS.md)**

Your sign-in lasts 30 days; a new session tells you a week before it ends. Upgrading moves
your /vibe session-start line in `~/.claude/settings.json` to the new version, and nothing
else in your settings changes.

Remove it: `npx slashvibe-mcp hook uninstall`, then delete the `vibe` server from your Claude
Code config.

## License

MIT
