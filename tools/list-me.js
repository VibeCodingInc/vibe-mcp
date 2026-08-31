/**
 * vibe list me — put YOURSELF on the people list.
 *
 * (Taking yourself off is tools/unlist-me.js.)
 *
 * Opt-in, always by the person's own action. Nothing in onboarding, presence,
 * messaging, or any other path may set this flag: listing is something you
 * say, never something that happens to you. Unlisting takes effect on the
 * next read — no client-side cache keeps a removed person visible.
 */

const store = require('../store');
const config = require('../config');
const { requireInit } = require('./_shared');
const { inertMarkup } = require('../incoming');
const { sameHandle } = require('../protocol/handle');

const listDefinition = {
  name: 'vibe_list_me',
  description:
    'Put YOURSELF on the /vibe people list so others can find you and message you, with a short line about what you are building. Opt-in and reversible (vibe_unlist_me). Only ever call this when the person asks to be listed.',
  inputSchema: {
    type: 'object',
    properties: {
      building: {
        type: 'string',
        maxLength: 140,
        description: 'What you are building, in a few words — this is what other people will see next to your handle.',
      },
    },
    additionalProperties: false,
  },
};

async function listHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const building = typeof args?.building === 'string' ? args.building.trim() : '';
  const result = await store.setListed(true, building);

  if (!result.ok) {
    if (result.error === 'identity_not_attested') {
      return {
        display:
          "Not listed — the people list needs a GitHub-backed identity, and this handle doesn't have one yet.\n" +
          '_sign in with GitHub:_ `vibe start`',
      };
    }
    if (result.error === 'unconfirmed') {
      // The server did not tell us whether the change took. Saying "nothing
      // changed" would be as false as claiming success (review P1).
      return {
        display:
          `I can't tell whether you were listed — the server didn't confirm it${result.message ? ` (${inertMarkup(result.message, 80)})` : ''}.\n` +
          '_read the list with_ `vibe people` _· take a listing back with_ `vibe unlist me`',
      };
    }
    return {
      display: `Not listed${result.message ? ` (${inertMarkup(result.message, 80)})` : ''} — nothing changed.`,
    };
  }

  // READ BACK before claiming (the send-contract discipline, applied to
  // listing): the platform accepting the flag is not the same fact as being
  // ON the list — some identities it accepts, it does not publish. Say which
  // actually happened; never claim a state that was not observed.
  const handle = config.getHandle();
  const buildingPart = building ? ` — building ${inertMarkup(building, 70)}` : '';
  const check = await store.getPeople();
  // The repo's canonical handle contract (@, case, whitespace, zero-width,
  // -/_ ) decides identity — a lowercase-only compare would report an
  // equivalent served handle as absent (review P2).
  const visible = check.ok
    ? check.listings.some((p) => sameHandle(p.handle, handle))
    : null;

  if (visible === true) {
    return {
      display:
        `✅ You're on the people list as @${handle}${buildingPart}.\n` +
        '_anyone signed in to /vibe can now find you there and DM you; take yourself off any time with_ `vibe unlist me`\n\n' +
        '_See who\'s here with_ `vibe people`',
    };
  }
  if (visible === false) {
    // State ONLY what was observed. Why the list does not show the handle is
    // not knowable from one read, so no cause is asserted (review P2) — and
    // the reversal is named here as everywhere else.
    return {
      display:
        `Your listing was saved${buildingPart}, but @${handle} is not on the people list I just read back.\n` +
        '_read it yourself with_ `vibe people` _· take the listing back any time with_ `vibe unlist me`',
    };
  }
  // The write succeeded; the read-back could not be made. Claim only the write.
  return {
    display:
      `Your listing was saved${buildingPart}. Couldn't read the list just now, so I won't claim you're on it.\n` +
      '_check with_ `vibe people` _· take the listing back any time with_ `vibe unlist me`',
  };
}

module.exports = { definition: listDefinition, handler: listHandler };
