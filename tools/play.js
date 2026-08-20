/**
 * vibe play — the open channel for emergent, AI-improvised social play
 *
 * game / poem / corpse each hardcode one activity's rules. This tool hardcodes
 * NONE. It is the bare primitive underneath all of them: carry an arbitrary
 * `state` object back and forth over the DM thread, with a freeform `note`, and
 * let the two Claude sessions invent whatever they want on top of it — chess,
 * 20 questions, a co-written story, a shared drawing, a debate, a game neither
 * player has a name for yet.
 *
 * The rules live in the conversation, not in this file. That's the whole point:
 * the platform supplies the presence + the channel; the creativity is emergent
 * from the humans and their Claudes. game/poem/corpse are now just friendly
 * on-ramps that teach the pattern; `vibe play` is the pattern itself.
 *
 * Transport is identical to the others: `payload: { type:'play', ... }` on a DM,
 * durable via the Postgres payload column, read back with store.getThread().
 */

const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle } = require('./_shared');

// Guardrail so a runaway state blob can't wedge the DM store. Generous — a
// chess board, a long story-so-far, or a 100-cell canvas all fit easily.
const MAX_STATE_BYTES = 24000;

/**
 * Find the most recent play session in a DM thread.
 */
function getPlaySession(thread) {
  for (let i = thread.length - 1; i >= 0; i--) {
    const p = thread[i].payload;
    if (p && p.type === 'play') return p;
  }
  return null;
}

/**
 * Accept state as a structured object/array/primitive, or a JSON string, or a
 * plain string. We never force a shape — whatever the two Claudes agree on.
 */
function coerceState(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return s; // not JSON — keep the raw string, it's a valid state too
    }
  }
  return raw;
}

function stateBytes(state) {
  if (state === undefined) return 0;
  try {
    return Buffer.byteLength(typeof state === 'string' ? state : JSON.stringify(state), 'utf8');
  } catch {
    return Infinity;
  }
}

/**
 * Render whatever state is, legibly, for the local Claude to reason about.
 */
function renderState(state) {
  if (state === undefined) return '_(no state yet — you define it)_';
  if (typeof state === 'string') return '```\n' + state + '\n```';
  try {
    return '```json\n' + JSON.stringify(state, null, 2) + '\n```';
  } catch {
    return '_(unrenderable state)_';
  }
}

const definition = {
  name: 'vibe_play',
  description:
    'The open channel for playing ANY shared activity with another viber — you and their Claude improvise the rules, this tool just carries the state. No built-in game logic. Use it for anything two sessions can invent: chess, 20 questions, a co-written story, battleship, a shared ascii drawing, a debate, a made-up game. ' +
    'Pass a freeform `state` (any JSON — the current board/story/whatever) and a `note` (a plain-language message to the other player and their Claude). ' +
    'Call it with no state to READ the current session so you can interpret it and take your turn. This is the primitive under vibe_game / vibe_poem / vibe_corpse — reach for it when the activity is anything else.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to play with (e.g., @solienne)',
      },
      note: {
        type: 'string',
        description:
          "A plain-language message to the other player and their Claude — what you did, whose turn it is, the rules if you're starting. This is what shows in their DM.",
      },
      state: {
        description:
          'The current activity state, as any JSON value (object, array, or string). Whatever shape you and the other Claude agree on — a board, a story-so-far, a score, moves. Omit to just read the current state.',
      },
      kind: {
        type: 'string',
        description:
          "A freeform label for the activity, e.g. 'chess', '20-questions', 'story', 'battleship'. You coin it — it's just a hint so both sides know what game this is.",
      },
      done: {
        type: 'boolean',
        description: 'Mark the activity finished after this turn.',
      },
    },
    required: ['handle'],
  },
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const me = config.getHandle();
  const them = normalizeHandle(args.handle);

  if (them === me) {
    return { display: "You can't play with yourself here — invite someone: `vibe play @handle`." };
  }

  const thread = await store.getThread(me, them);
  const last = getPlaySession(thread);

  const incomingState = coerceState(args.state);
  const note = args.note ? String(args.note).trim() : '';
  const kind = (args.kind ? String(args.kind).trim() : '') || (last && last.kind) || null;
  const done = args.done === true;

  const hasWrite = incomingState !== undefined || note || done;

  // ── READ: no write args → surface the current session for this Claude to act on.
  if (!hasWrite) {
    if (!last) {
      return {
        display:
          `## play with @${them}\n\n` +
          `_No shared activity going yet._\n\n` +
          `Start anything — you and @${them}'s Claude make up the rules. Examples:\n` +
          `\`vibe play @${them} --kind "chess" --note "you're white, your move" --state '{"board":"start"}'\`\n` +
          `\`vibe play @${them} --kind "20-questions" --note "I'm thinking of something. ask away."\`\n` +
          `\`vibe play @${them} --kind "story" --note "once upon a time..." --state "once upon a time"\`\n\n` +
          `(For the classics there are shortcuts: \`vibe game\`, \`vibe poem\`, \`vibe corpse\`.)`,
      };
    }

    const who = last.by === me ? 'you' : `@${last.by}`;
    let display = `## play with @${them}${last.kind ? ` — ${last.kind}` : ''}\n\n`;
    if (last.note) display += `last from ${who}: "${last.note}"\n\n`;
    display += `state:\n${renderState(last.state)}\n`;
    if (last.done) {
      display += `\n✨ This one's finished. Start another with \`vibe play @${them} …\``;
    } else if (last.by === me) {
      display += `\n_Waiting on @${them} — they play next._`;
    } else {
      display +=
        `\n**Your move.** Interpret the state above, decide what happens next, and send it back:\n` +
        `\`vibe play @${them}${last.kind ? ` --kind "${last.kind}"` : ''} --note "…" --state '{…}'\`  (add \`--done\` to finish)`;
    }
    return { display };
  }

  // ── WRITE: take a turn.
  // Carry the previous state forward if the caller didn't supply a new one.
  const newState = incomingState !== undefined ? incomingState : last ? last.state : undefined;

  if (stateBytes(newState) > MAX_STATE_BYTES) {
    return {
      display: `That state is too big (>${Math.round(MAX_STATE_BYTES / 1000)}KB). Keep the shared state compact — summarize instead of accumulating raw history.`,
    };
  }

  const payload = {
    type: 'play',
    kind: kind || null,
    state: newState,
    note: note || null,
    by: me,
    done,
  };

  // The DM body is what lands in their inbox. Lead with the note; add a light
  // hint so their Claude knows to open the session and respond.
  let body;
  if (done) {
    body = note ? `${note}\n\n(sealed our ${kind || 'game'} 🎲)` : `Sealed our ${kind || 'game'} 🎲`;
  } else {
    body = note || `Your move 🎲`;
    body += `\n\n▸ open with \`vibe play @${me}\` to see the state and reply`;
  }

  await store.sendMessage(me, them, body, 'dm', payload);

  let display = `## play with @${them}${kind ? ` — ${kind}` : ''}\n\n`;
  display += `state:\n${renderState(newState)}\n`;
  if (done) {
    display += `\n✨ Sealed and sent to @${them}. Start another anytime.`;
  } else {
    display += `\nSent to @${them}. Waiting for their move…`;
  }
  return { display };
}

module.exports = { definition, handler };
