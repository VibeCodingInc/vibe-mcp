/**
 * vibe help — Quick reference for /vibe commands
 *
 * Shows the ACTUAL registered tool surface, a getting-started guide, and support
 * info. Every command listed here must correspond to a registered vibe_* tool —
 * the packed-artifact test (test/pack-artifact.test.mjs) asserts this so help
 * cannot drift back into advertising tools that do not ship.
 *
 * 0.8 core mode: the kernel (presence + messaging) registers by default; the
 * culture layer (ship/feed/play/game/poem/corpse/weave/fable/intro/email) only
 * with VIBE_EXTRAS=1. Help follows the same switch — with extras off, extras
 * commands are named WITHOUT the `vibe X` form so the drift guard stays honest.
 */

const config = require('../config');

const EXTRAS_ENABLED = ['1', 'true'].includes(String(process.env.VIBE_EXTRAS || '').toLowerCase());

const definition = {
  name: 'vibe_help',
  description: 'Show available /vibe commands and quick start guide',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: `Optional: specific topic (commands, getting-started${EXTRAS_ENABLED ? ', play' : ''}, troubleshooting)`
      }
    }
  }
};

// Commands map 1:1 to registered tools. Keep in sync with index.js registration
// (the pack-artifact test enforces this).
const KERNEL_COMMANDS = `## /vibe Commands

The kernel: presence + messaging across terminal coding sessions
(Claude Code, Codex, Cursor — anywhere this MCP server is installed).

### Presence
- \`vibe start\` (or just \`vibe\`) — Start your session, see who's around
- \`vibe who\` — See who's online and what they're building
- \`vibe status <mood>\` — Set mood (shipping, thinking, afk, debugging, pairing, deep) or pace (slower, quiet, normal)
- \`vibe bye\` — End your session with a summary

### Messaging
- \`vibe dm @handle "message"\` — Send a direct message. Lands now if they're in a session, waits for their next turn if not
- \`vibe reply "message"\` — Reply to your most recent unread (or a specific person)
- \`vibe inbox\` — See unread messages and recent threads

### Setup
- \`vibe init\` — Sign in with GitHub (your username becomes your @handle)
- \`vibe token <token>\` — Set your auth token after browser auth
- \`vibe help [topic]\` — This help

Unread messages surface automatically in the footer of every response —
no need to poll the inbox.`;

const EXTRAS_COMMANDS = `

### Ship & Feed
- \`vibe ship "what you built"\` — Announce a ship to the community board
- \`vibe feed\` — See the creative feed: ideas, ships, requests
- \`vibe intro @handle\` — Introduce yourself to someone new
- \`vibe email\` — Get pinged about DMs you miss while away

### Play
- \`vibe play @handle\` — Freeform shared play: invent any game/story/drawing over DM
- \`vibe game @handle\` — Turn-based game with rules (tictactoe, chess)
- \`vibe poem @handle\` — Co-write a collaborative poem
- \`vibe corpse @handle\` — Exquisite-corpse story (hidden-state)
- \`vibe weave\` — The Weave: attach this session's strand
- \`vibe fable @handle\` — The Weave, deepest form: co-author a living shared artifact`;

// Extras are OFF: name them without the `vibe X` command form (the pack-artifact
// drift test treats any `vibe X` in help as an advertised command).
const EXTRAS_HINT = `

### Extras (off by default)
The culture layer — shipping, the feed, intros, email pings, and shared play
(games, poems, exquisite corpse, the Weave) — is opt-in. Set \`VIBE_EXTRAS=1\`
in the vibe MCP server env and restart your coding agent to enable it.`;

const COMMANDS = KERNEL_COMMANDS + (EXTRAS_ENABLED ? EXTRAS_COMMANDS : EXTRAS_HINT);

const GETTING_STARTED = `## Getting Started with /vibe

You're already in — your @handle comes from your GitHub login, nothing to set up.
The whole point of /vibe: message a real person without leaving your terminal,
whichever coding agent you're in (Claude Code, Codex, Cursor).

### 1. See who's around
\`\`\`
vibe who
\`\`\`
Real people building right now, most-recently-active first.

### 2. Message one of them
\`\`\`
vibe dm @handle "hey — saw you're building X. what are you using for Y?"
\`\`\`
It lands in their terminal — now if they're in a session, on their next turn if
not. Neither of you has to be online. When they reply, it lands in yours
(\`vibe inbox\`, or right in your session footer).

### 3. Stay reachable
Presence is automatic: this server heartbeats while your session is open, and
you fade to away when you close it. \`vibe status shipping\` to say what's up.

That's it. Say hi to someone — that's the whole thing.`;

const PLAY_INFO = EXTRAS_ENABLED ? `## Play on /vibe

Shared, real-time experiences over the DM transport — you and another viber's
Claude carry state back and forth:

- \`vibe play @handle\` — The open primitive. No built-in rules; you two invent
  anything (a debate, a made-up game, a shared sketch). State lives in the thread.
- \`vibe game @handle\` — Rule-enforced turn-based games: tictactoe, chess
  (legal-move checking, board rendering).
- \`vibe poem @handle\` — A collaborative poem with turn/line structure and sealing.
- \`vibe corpse @handle\` — Exquisite corpse: each writer sees only the last line
  (hidden-state), revealed when complete.
- \`vibe weave\` / \`vibe fable @handle\` — The Weave: attach a strand, or co-author
  a living shared artifact that Fable merges across both terminals.` : `## Play on /vibe

Play (games, poems, exquisite corpse, the Weave) is part of the extras layer,
which is off by default. Set \`VIBE_EXTRAS=1\` in the vibe MCP server env and
restart your coding agent to enable it.`;

const TROUBLESHOOTING = `## Troubleshooting

### "Not initialized"
Run \`vibe init\` — it opens your browser to sign in with GitHub, and your
GitHub username becomes your @handle automatically (no handle to pick).
If the browser flow gives you a token, set it with \`vibe token <token>\`.

### Messages not sending
1. Confirm you're signed in: \`vibe who\` should return results.
2. Re-run \`vibe init\` if your session expired.
3. Check whether the recipient has consented / not blocked you.

### Not seeing who's online
Presence updates periodically. Run \`vibe who\` for fresh data.

### Where did ship / play / the Weave go?
0.8 core mode trims the default surface to presence + messaging. Set
\`VIBE_EXTRAS=1\` in the vibe MCP server env to restore the culture layer.

### Report issues
- GitHub: https://github.com/VibeCodingInc/vibe-mcp/issues`;

async function handler(args) {
  const { topic } = args;
  const handle = config.getHandle();
  const isInitialized = !!handle;

  if (topic) {
    const t = topic.toLowerCase();
    if (t === 'commands' || t === 'cmd') {
      return { display: COMMANDS };
    }
    if (t === 'start' || t === 'getting-started' || t === 'quickstart') {
      return { display: GETTING_STARTED };
    }
    if (t === 'play' || t === 'games') {
      return { display: PLAY_INFO };
    }
    if (t === 'troubleshooting' || t === 'debug' || t === 'issues') {
      return { display: TROUBLESHOOTING };
    }
    return {
      display: `## Unknown Topic: "${topic}"

Available topics:
- \`commands\` — List of all commands
- \`getting-started\` — Quick start guide${EXTRAS_ENABLED ? '\n- `play` — Shared games and creative sessions' : ''}
- \`troubleshooting\` — Fix common issues`
    };
  }

  const display = `## /vibe Help

${isInitialized ? `You're **@${handle}**` : '⚠️ Not signed in yet — run `vibe init` (GitHub signs you in, your username becomes your handle)'}

Presence + messaging across terminal coding sessions. Install once, reachable
from Claude Code, Codex, and Cursor.

### Quick Reference
| Action | Command |
|--------|---------|
| See who's around | \`vibe who\` |
| Message someone | \`vibe dm @handle "msg"\` |
| Check inbox | \`vibe inbox\` |
| Set your status | \`vibe status shipping\` |
| Start your session | \`vibe start\` |${EXTRAS_ENABLED ? `
| Ship something | \`vibe ship "what you built"\` |
| Play together | \`vibe play @handle\` |` : ''}

### Topics
- \`vibe help commands\` — All commands
- \`vibe help getting-started\` — Quick start${EXTRAS_ENABLED ? '\n- `vibe help play` — Shared games and creative sessions' : ''}
- \`vibe help troubleshooting\` — Fix issues

### Links
- Docs: https://www.slashvibe.dev/llms.txt
- Issues: https://github.com/VibeCodingInc/vibe-mcp/issues`;

  return { display };
}

module.exports = { definition, handler };
