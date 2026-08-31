/**
 * vibe people — the people who CHOSE to be findable.
 *
 * Deliberately distinct from `vibe who` (who is present right now). This is
 * the opt-in list: everyone here flipped it on themselves and can flip it off
 * at any moment. Flat and alphabetical as served — this renderer never ranks,
 * never recommends, never marks anyone "suggested for you", and never picks a
 * recipient. Choosing is the human's act.
 *
 * Entries are foreign text (someone else's handle and words), so they are
 * rendered inert.
 */

const store = require('../store');
const { requireInit } = require('./_shared');
const { inertField } = require('../incoming');

const definition = {
  name: 'vibe_people',
  description:
    'Show the people who chose to be findable on /vibe (opt-in) — whether or not they are online right now. Different from vibe_who, which is who is present this moment. Flat list, no ranking or recommendations; the human chooses who to message.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

async function handler() {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const result = await store.getPeople();
  if (!result.ok) {
    return {
      display: `Couldn't reach the people list${result.message ? ` (${inertField(result.message, 80)})` : ''} — nothing shown rather than a stale list.`,
    };
  }

  const listings = result.listings;
  if (listings.length === 0) {
    return {
      display:
        '👥 **people** — nobody is on the list yet.\n\n' +
        '_this is the opt-in list, not who is online (that is_ `vibe who`_)._\n' +
        '_put yourself on it with_ `vibe list me "what you\'re building"`',
    };
  }

  // As served: alphabetical, unchanged. Agents are labeled, not sorted apart.
  const lines = listings.map((p) => {
    const handle = inertField(String(p.handle || ''), 40);
    const kind = p.kind === 'agent' ? ' 🤖' : '';
    const building = p.building ? ` — ${inertField(String(p.building), 70)}` : '';
    return `• @${handle}${kind}${building}`;
  });

  return {
    display:
      `👥 **people** (${listings.length}) — everyone here chose to be findable\n` +
      '_not the same as_ `vibe who`_, which is who is present right now_\n\n' +
      `${lines.join('\n')}\n\n` +
      '_Choose someone because their work makes you curious:_ `vibe dm @handle "…"`',
    footer: 'minimal',
  };
}

module.exports = { definition, handler };
