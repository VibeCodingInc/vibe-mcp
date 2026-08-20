/**
 * vibe poem — Write an emoji poem together, one line at a time
 *
 * The original January /vibe magic: two people co-authoring something small
 * and playful inside Claude Code, passed back and forth over the DM transport.
 * Each turn adds a line; the poem state travels in the message payload (durable
 * via the Postgres payload column), exactly like `vibe game`.
 */

const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle } = require('./_shared');

// Poems seal automatically at this many lines (either player can seal earlier).
const MAX_LINES = 8;

/**
 * Find the most recent poem state in a DM thread.
 */
function getPoemState(thread) {
  for (let i = thread.length - 1; i >= 0; i--) {
    const p = thread[i].payload;
    if (p && p.type === 'poem' && p.state) return p.state;
  }
  return null;
}

/**
 * Render a poem for the terminal.
 */
function renderPoem(state, { withMe, them } = {}) {
  const lines = state.lines || [];
  let out = '📜 **emoji poem';
  if (state.title) out += ` — ${state.title}`;
  out += '**\n\n';
  if (!lines.length) {
    out += '_(blank page — add the first line)_\n';
  } else {
    out += '```\n';
    for (const l of lines) out += `${l.text}\n`;
    out += '```\n';
    out += `\n_by ${uniqueAuthors(lines).map((a) => '@' + a).join(' & ')}_\n`;
  }
  return out;
}

function uniqueAuthors(lines) {
  const seen = [];
  for (const l of lines) if (!seen.includes(l.author)) seen.push(l.author);
  return seen;
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

async function postPoemToBoard(state, authors) {
  const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
  const body = (state.lines || []).map((l) => l.text).join(' / ');
  try {
    await fetch(`${API_URL}/api/board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'echo',
        content: `${authors.map((a) => '@' + a).join(' & ')} finished an emoji poem: ${body}`,
        category: 'general',
      }),
    });
  } catch (e) {
    console.error('[poem] Failed to post to board:', e.message);
  }
}

const definition = {
  name: 'vibe_poem',
  description:
    'Write an emoji poem together, one line at a time. Pass it back and forth with someone — each turn adds a line. `vibe poem @handle --line "🌊🌙 the tide remembers"`',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to write with (e.g., @solienne)',
      },
      line: {
        type: 'string',
        description: 'The line to add (emoji-forward, but any text welcome)',
      },
      title: {
        type: 'string',
        description: 'Optional title, only used when starting a new poem',
      },
      done: {
        type: 'boolean',
        description: 'Seal the poem as finished after adding your line',
      },
    },
    required: ['handle'],
  },
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { line, title, done } = args;
  const me = config.getHandle();
  const them = normalizeHandle(args.handle);

  if (them === me) {
    return { display: "You can't write a poem with yourself. Invite someone: `vibe poem @handle`." };
  }

  const thread = await store.getThread(me, them);
  let state = getPoemState(thread);

  // No line provided → show the current poem (or start a fresh one).
  if (!line) {
    if (!state) {
      const newState = { lines: [], title: title || null, done: false, startedBy: me };
      await store.sendMessage(
        me,
        them,
        `Let's write an emoji poem together 📜 Add a line: \`vibe poem @${me} --line "…"\``,
        'dm',
        { type: 'poem', state: newState }
      );
      return {
        display:
          `## New emoji poem with @${them}\n\n${renderPoem(newState)}\n` +
          `Add the first line: \`vibe poem @${them} --line "🌱 a small green start"\``,
      };
    }

    // Show existing poem.
    const authors = uniqueAuthors(state.lines);
    let display = `## emoji poem with @${them}\n\n${renderPoem(state)}\n`;
    if (state.done) {
      display += `\n✨ Finished. Start another: \`vibe poem @${them} --line "…"\``;
    } else if (isMyTurn(state, me)) {
      display += `\nYour turn — add a line: \`vibe poem @${them} --line "…"\``;
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
      display: `This poem is finished. Start a new one: \`vibe poem @${them} --line "…"\``,
    };
  }

  if (!isMyTurn(state, me)) {
    return {
      display:
        `It's @${them}'s turn to add a line.\n\n${renderPoem(state)}\n` +
        `Nudge them, or wait for their line.`,
    };
  }

  const text = String(line).trim();
  if (!text) return { display: 'Give me a line to add: `vibe poem @handle --line "…"`' };
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
    message = `Added a line and sealed our poem 📜✨\n\n${newLines.map((l) => l.text).join('\n')}`;
    if (authors.length > 1) postPoemToBoard(newState, authors);
  } else if (isMyTurn(newState, them)) {
    message = `Added a line — your turn 📜\n"${text}"`;
  } else {
    message = `Added a line 📜\n"${text}"`;
  }

  await store.sendMessage(me, them, message, 'dm', { type: 'poem', state: newState });

  let display = `## emoji poem with @${them}\n\n${renderPoem(newState)}\n`;
  if (shouldSeal) {
    display += `\n✨ Poem sealed${newLines.length >= MAX_LINES ? ` (${MAX_LINES} lines)` : ''}. Start another anytime.`;
  } else {
    display += `\nSent to @${them}. Waiting for their line…`;
  }
  return { display };
}

module.exports = { definition, handler };
