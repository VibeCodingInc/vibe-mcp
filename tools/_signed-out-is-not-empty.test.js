/**
 * "Signed out" and "nobody is here" are different facts, and the room board must not
 * confuse them.
 *
 * Observed on the Mac Studio, 2026-08-01. A session holding a token that had expired 23
 * days earlier asked who was around and was told:
 *
 *     Quiet right now — you're the only one here.
 *
 * Four people were online. The server had answered honestly — v1 replies `anonymous:
 * true` with public COUNTS ("2 here, sign in to see who"), v2 replies with a hard 401 —
 * and `getActiveUsers()` discarded both, handing every caller a bare `[]`.
 *
 * That is the most damaging sentence this product can say. The entire promise is that
 * other people are there; telling a signed-out person the room is dead is a false claim
 * delivered at the exact moment they are deciding whether any of this works. It also
 * lands squarely on the invite path, where being signed out is the NORMAL first state.
 *
 * Two sub-cases, and the second is easy to get wrong: when the server supplies no count
 * (the v2 401), the board must not say "0 people are here". Inventing a number to fill
 * the silence is the same lie in a different costume.
 *
 * Run: node --test tools/_signed-out-is-not-empty.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('module');

/** Load who.js with store.getActiveUsers stubbed to a given presence answer. */
function whoWith(users) {
  const storePath = require.resolve('../store/api.js');
  const whoPath = require.resolve('./who.js');
  const sharedPath = require.resolve('./_shared.js');

  const realStore = require(storePath);
  const originalGet = realStore.getActiveUsers;
  realStore.getActiveUsers = async () => users;

  delete require.cache[whoPath];
  const who = require(whoPath);

  return {
    run: () => who.handler({}),
    restore: () => {
      realStore.getActiveUsers = originalGet;
      delete require.cache[whoPath];
    },
  };
}

/** An array carrying the out-of-band signal the store attaches. */
function presence(list, { anonymous = false, counts = null } = {}) {
  const arr = [...list];
  Object.defineProperties(arr, {
    anonymous: { value: anonymous, enumerable: false },
    counts: { value: counts, enumerable: false },
  });
  return arr;
}

test('signed out with a public count says so, and reports the count', async () => {
  const h = whoWith(presence([], { anonymous: true, counts: { active: 2 } }));
  try {
    const r = await h.run();
    assert.equal(r.structured.signedOut, true, 'the structured result must say signed out');
    assert.match(r.display, /signed out/i);
    assert.match(r.display, /2 people are here/, 'a public count must be reported, not hidden');
    assert.ok(
      !/only one here|quiet right now/i.test(r.display),
      'must NOT claim the room is empty — this is the Mac Studio bug',
    );
  } finally { h.restore(); }
});

test('signed out with NO count claims no number at all', async () => {
  // The v2 path: a hard 401 and nothing else. "0 people are here" would be a fresh lie.
  const h = whoWith(presence([], { anonymous: true, counts: null }));
  try {
    const r = await h.run();
    assert.equal(r.structured.signedOut, true);
    assert.match(r.display, /can't see who's here/i);
    assert.ok(!/\b0 people\b/.test(r.display), 'must not invent a count it was not given');
    assert.ok(!/only one here/i.test(r.display));
  } finally { h.restore(); }
});

test('genuinely empty AND signed in still reads as an empty room', async () => {
  // The other empty state must survive — it is a real and different fact.
  const h = whoWith(presence([], { anonymous: false }));
  try {
    const r = await h.run();
    assert.ok(!r.structured.signedOut, 'a signed-in caller is not signed out');
    assert.match(r.display, /only one here/i);
  } finally { h.restore(); }
});
