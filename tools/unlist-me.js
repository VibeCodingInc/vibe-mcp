/**
 * vibe unlist me — take YOURSELF off the people list.
 *
 * The reverse of tools/list-me.js and just as much the person's own act.
 * Unlisting takes effect on the next read: nothing client-side keeps a
 * removed person visible.
 */

const store = require('../store');
const config = require('../config');
const { requireInit } = require('./_shared');
const { inertMarkup } = require('../incoming');

const definition = {
  name: 'vibe_unlist_me',
  description:
    'Take YOURSELF off the /vibe people list. You stay signed in and keep every conversation; you just stop being findable there.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

async function handler() {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const result = await store.setListed(false);
  if (!result.ok) {
    if (result.error === 'unconfirmed') {
      return {
        display:
          `I can't tell whether you were taken off — the server didn't confirm it${result.message ? ` (${inertMarkup(result.message, 80)})` : ''}.\n` +
          '_read the list with_ `vibe people`',
      };
    }
    return {
      display: `Still listed${result.message ? ` (${inertMarkup(result.message, 80)})` : ''} — nothing changed.`,
    };
  }
  const handle = config.getHandle();
  return {
    display:
      `You're off the people list. Nobody browsing it will see @${handle}.\n` +
      '_your conversations are untouched; list yourself again any time with_ `vibe list me "what you\'re building"`',
  };
}

module.exports = { definition, handler };
