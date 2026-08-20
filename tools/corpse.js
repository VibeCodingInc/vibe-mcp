/**
 * vibe corpse — Write an exquisite corpse together, one line at a time
 *
 * The surrealist parlor game, ported to the terminal. Two people build a story
 * (or a poem) by alternating lines — but you only ever see the LAST line the
 * other person wrote, never the whole thing. When someone seals it, the full
 * corpse is revealed to both, usually gloriously nonsensical.
 *
 * Same transport as `vibe poem` / `vibe game`: the story state travels in the
 * DM message payload (durable via the Postgres payload column), passed back and
 * forth over the DM thread. The only new idea here is that render hides every
 * line but the last until the story is sealed.
 */

const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle } = require('./_shared');

// Corpses seal automatically at this many lines (either player can seal earlier).
const MAX_LINES = 10;

/**
 * Find the most recent corpse state in a DM thread.
 */
function getCorpseState(thread) {
  for (let i = thread.length - 1; i >= 0; i--) {
    const p = thread[i].payload;
    if (p && p.type === 'corpse' && p.state) return p.state;
  }
  return null;
}

function uniqueAuthors(lines) {
  const seen = [];
  for (const l of lines) if (!seen.includes(l.author)) seen.push(l.author);
  return seen;
}

/**
 * Render the full, revealed corpse (only shown once sealed).
 */
function renderReveal(state) {
  const lines = state.lines || [];
  let out = '💀 **exquisite corpse';
  if (state.title) out += ` — ${state.title}`;
  out += '**\n\n';
  if (!lines.length) {
    out += '_(empty — nothing was written)_\n';
  } else {
    out += '```\n';
    for (const l of lines) out += `${l.text}\n`;
    out += '```\n';
    out += `\n_by ${uniqueAuthors(lines).map((a) => '@' + a).join(' & ')} — ${lines.length} lines_\n`;
  }
  return out;
}

/**
 * Render the *in-progress* corpse: the whole story stays folded, you only see
 * the last line to build from. This is the whole point of the game.
 */
function renderFolded(state, me) {
  const lines = state.lines || [];
  let out = '💀 **exquisite corpse';
  if (state.title) out += ` — ${state.title}`;
  out += '**\n\n';
  if (!lines.length) {
    out += '_(blank page — write the opening line; the rest stays hidden)_\n';
    return out;
  }
  const last = lines[lines.length - 1];
  const hiddenCount = lines.length - 1;
  out += '```\n';
  if (hiddenCount > 0) {
    out += `… ${hiddenCount} line${hiddenCount === 1 ? '' : 's'} folded out of sight …\n`;
  }
  out += `${last.text}\n`;
  out += '```\n';
  out += `\n_only the last line shows — continue from it, blind to the rest_\n`;
  return out;
}

/**
 * Whose turn is it? Alternate off the last line's author. If the last line was
 * mine, it's their turn; if theirs (or empty), it's mine.
 */
function isMyTurn(state, me) {
  const lines = state.lines || [];
  if (!lines.length) return true; // whoever opens goes first
  return lines[lines.length - 1].author !== me;
}

async function postCorpseToBoard(state, authors) {
  const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
  const body = (state.lines || []).map((l) => l.text).join(' / ');
  try {
    await fetch(`${API_URL}/api/board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'echo',
        content: `${authors.map((a) => '@' + a).join(' & ')} unfolded an exquisite corpse: ${body}`,
        category: 'general',
      }),
    });
  } catch (e) {
    console.error('[corpse] Failed to post to board:', e.message);
  }
}

const definition = {
  name: 'vibe_corpse',
  description:
    'Write an exquisite corpse together — a surrealist story where you only ever see the LAST line, never the whole thing, until it is sealed and revealed. Pass it back and forth: each turn adds a line, blind to what came before. `vibe corpse @handle --line "the clock swallowed its own hands"`',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to write with (e.g., @solienne)',
      },
      line: {
        type: 'string',
        description: 'The line to add — builds from the last visible line only',
      },
      title: {
        type: 'string',
        description: 'Optional title, only used when starting a new corpse',
      },
      done: {
        type: 'boolean',
        description: 'Seal the corpse after adding your line, revealing the whole thing to both of you',
      },
      reveal: {
        type: 'boolean',
        description: 'Show the full revealed corpse (only works once it has been sealed)',
      },
    },
    required: ['handle'],
  },
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { line, title, done, reveal } = args;
  const me = config.getHandle();
  const them = normalizeHandle(args.handle);

  if (them === me) {
    return { display: "You can't play exquisite corpse with yourself — half the fun is the surprise. Invite someone: `vibe corpse @handle`." };
  }

  const thread = await store.getThread(me, them);
  let state = getCorpseState(thread);

  // Explicit reveal request.
  if (reveal) {
    if (!state) {
      return { display: `No corpse with @${them} yet. Start one: \`vibe corpse @${them} --line "…"\`` };
    }
    if (!state.done) {
      return {
        display:
          `That corpse isn't sealed yet — no peeking! 💀\n\n${renderFolded(state, me)}\n` +
          (isMyTurn(state, me)
            ? `Your turn — add a line: \`vibe corpse @${them} --line "…"\``
            : `Waiting for @${them} to add the next line…`),
      };
    }
    return { display: `## exquisite corpse with @${them}\n\n${renderReveal(state)}` };
  }

  // No line provided → show current status (folded), or start a fresh corpse.
  if (!line) {
    if (!state) {
      const newState = { lines: [], title: title || null, done: false, startedBy: me };
      await store.sendMessage(
        me,
        them,
        `Let's play exquisite corpse 💀 A surrealist story where you only see my last line. Add yours: \`vibe corpse @${me} --line "…"\``,
        'dm',
        { type: 'corpse', state: newState }
      );
      return {
        display:
          `## New exquisite corpse with @${them}\n\n${renderFolded(newState, me)}\n` +
          `Write the opening line: \`vibe corpse @${them} --line "the moon filed a complaint"\``,
      };
    }

    // Show existing corpse (folded unless sealed).
    if (state.done) {
      return {
        display:
          `## exquisite corpse with @${them}\n\n${renderReveal(state)}\n` +
          `✨ Sealed. Start another: \`vibe corpse @${them} --line "…"\``,
      };
    }
    let display = `## exquisite corpse with @${them}\n\n${renderFolded(state, me)}\n`;
    if (isMyTurn(state, me)) {
      display += `\nYour turn — add a line (blind to the rest): \`vibe corpse @${them} --line "…"\``;
    } else {
      display += `\nWaiting for @${them} to add the next line…`;
    }
    return { display };
  }

  // Adding a line.
  if (!state) {
    state = { lines: [], title: title || null, done: false, startedBy: me };
  }

  if (state.done) {
    return {
      display:
        `This corpse is already sealed 💀\n\n${renderReveal(state)}\n` +
        `Start a new one: \`vibe corpse @${them} --line "…"\``,
    };
  }

  if (!isMyTurn(state, me)) {
    return {
      display:
        `It's @${them}'s turn to add a line.\n\n${renderFolded(state, me)}\n` +
        `Nudge them, or wait for their line.`,
    };
  }

  const text = String(line).trim();
  if (!text) return { display: 'Give me a line to add: `vibe corpse @handle --line "…"`' };
  if (text.length > 200) return { display: 'Keep each line under 200 characters.' };

  const newLines = [...(state.lines || []), { author: me, text }];
  const shouldSeal = done === true || newLines.length >= MAX_LINES;
  const newState = {
    ...state,
    lines: newLines,
    done: shouldSeal,
  };

  const authors = uniqueAuthors(newLines);
  let message;
  if (shouldSeal) {
    // On seal, the full corpse is revealed — send it in the DM so both sides see it.
    message =
      `Sealed our exquisite corpse 💀✨ Here's the whole thing, unfolded:\n\n` +
      newLines.map((l) => l.text).join('\n');
    if (authors.length > 1) postCorpseToBoard(newState, authors);
  } else {
    // Mid-game: only tell them it's their turn. Do NOT echo the story — keep it folded.
    message = `Added a line to our corpse — your turn 💀 You'll only see my last line:\n"${text}"`;
  }

  await store.sendMessage(me, them, message, 'dm', { type: 'corpse', state: newState });

  if (shouldSeal) {
    let display = `## exquisite corpse with @${them}\n\n${renderReveal(newState)}\n`;
    display += `\n✨ Corpse sealed${newLines.length >= MAX_LINES ? ` (${MAX_LINES} lines)` : ''} and revealed to you both. Start another anytime.`;
    return { display };
  }

  let display = `## exquisite corpse with @${them}\n\n${renderFolded(newState, me)}\n`;
  display += `\nYour line is in. Sent to @${them}, folded away — waiting for theirs…`;
  return { display };
}

module.exports = { definition, handler };
