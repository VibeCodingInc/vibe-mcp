/**
 * vibe intro — Received collaboration.
 *
 * The newcomer's agent knows what they're building this session (context only
 * /vibe can see). This tool takes that one-line summary, finds a real human
 * online whose current work / recent ship overlaps, and DRAFTS a two-sided warm
 * intro so the newcomer arrives already in a relevant conversation instead of
 * cold-DMing a stranger.
 *
 * Default is draft-only: the tool composes who + what-to-say (the hard part) and
 * the user sends with one word. Pass send:true to actually deliver after they
 * assent — the send routes through the normal authenticated vibe_dm path.
 */

const config = require('../config');
const store = require('../store');
const {
  requireInit,
  normalizeHandle,
  pickRelatedTarget,
  pickDormantTarget,
} = require('./_shared');

const definition = {
  name: 'vibe_intro',
  description:
    "Introduce this user to a real human online who's building something related, so they land mid-conversation instead of staring at an empty inbox. " +
    'Call this right after vibe_init succeeds (and any time a returning user hasn\'t connected yet). ' +
    'Pass `building`: a short, specific, first-person-free summary of what the user is actually working on in THIS session — infer it from the current files, project, and recent work (e.g. "an OAuth PKCE login flow in a Next.js app", "a Postgres migration for a chat schema", "a Tauri menubar app"). ' +
    'The tool finds the best-matched online human and drafts a warm two-sided opener. By default it only DRAFTS — show the user the match and the message, ask if they want to send it, then call again with send:true once they say yes.',
  inputSchema: {
    type: 'object',
    properties: {
      building: {
        type: 'string',
        description:
          "One line describing what the user is working on this session, inferred from their actual context (files, project, recent work). Specific beats generic — 'realtime auth with WebSockets' matches better than 'a web app'.",
      },
      send: {
        type: 'boolean',
        description:
          'Set true ONLY after the user has agreed to send the drafted intro. Delivers the message via the normal DM path.',
      },
      handle: {
        type: 'string',
        description:
          'Optional: send to this specific person instead of the auto-matched one (used with send:true when the user picks someone else).',
      },
      message: {
        type: 'string',
        description:
          'Optional: override the drafted opener with custom text (used with send:true).',
      },
    },
    required: [],
  },
};

async function handler(args = {}) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const { building, send } = args;

  // Fetch who's around and drop self.
  let others = [];
  try {
    const users = await store.getActiveUsers();
    others = (users || []).filter((u) => u && u.handle && u.handle !== myHandle);
  } catch (e) {
    others = [];
  }

  // ── Send path: user has assented, deliver the intro ───────────────────────
  if (send === true) {
    let target = args.handle ? normalizeHandle(args.handle) : null;
    let message = args.message || null;

    // If no explicit target/message, re-derive the match so send is self-contained.
    if (!target || !message) {
      const match =
        (building && pickRelatedTarget(others, building)) || pickDormantTarget(others);
      if (!match) {
        return {
          display:
            "No one who lines up is around this second. Try `vibe who` to see everyone, or `vibe ship <what you're building>` so the next person who arrives finds you.",
        };
      }
      target = target || match.handle;
      message = message || match.opener;
    }

    const dm = require('./dm');
    const result = await dm.handler({ handle: target, message, origin: 'intro' });
    // dm.handler already returns a display + marks firstDmSent on success.
    if (result && result.display && /failed/i.test(result.display)) return result;

    return {
      display:
        `✨ **You're introduced.** Your note just landed in @${target}'s terminal — ` +
        `you're mid-conversation now, no cold open required.\n\n` +
        `_When they reply you'll see it here. Want to meet more people? \`vibe who\`._`,
      _sent: true,
    };
  }

  // ── Draft path (default): compose the intro, let the user decide ──────────
  if (!others.length) {
    return {
      display:
        "Nobody's online right this second to introduce you to. " +
        "Run `vibe ship <what you're building>` so the next builder who arrives sees your work — " +
        'or `vibe who` in a bit to check again.',
    };
  }

  const related = building ? pickRelatedTarget(others, building) : null;
  const target = related || pickDormantTarget(others);

  if (!target) {
    return {
      display:
        "There are people around, but I couldn't line anyone up by topic yet. " +
        '`vibe who` shows everyone online — say hi to whoever looks interesting.',
    };
  }

  const sharedTopic =
    related && related.shared && related.shared.length
      ? related.shared.slice(0, 2).join(', ')
      : null;

  const lede = related
    ? `**✨ Someone you should meet: @${target.handle} is online right now** — ` +
      (sharedTopic
        ? `you're both deep in ${sharedTopic}.`
        : 'looks like a topical match.')
    : `**👋 @${target.handle} is around right now** — a good first person to meet.`;

  return {
    display:
      `${lede}\n\n` +
      `I drafted an intro from you:\n` +
      `> ${target.opener}\n\n` +
      `Want me to send it? Say **yes** and I'll introduce you — or **\`vibe who\`** to browse everyone first.`,
    _draft: { handle: target.handle, message: target.opener, related: !!related },
  };
}

module.exports = { definition, handler };
