'use strict';

/**
 * Noticing: what the agent is shown and told so that it notices when the work
 * touches someone the person knows, and offers a message (as a draft) at that
 * moment. Text only: nothing here sends, and nothing here changes how a send
 * is checked (tools/drafts.js, confirm-box.js, turns.js).
 *
 * Lab 2026-11-21 (20 outside-written pairs): in 12 of the 18 pairs where one
 * person held something the other needed, the agent never drafted at all;
 * where it did draft, every message was sent by the person's choice. So the
 * weak point was noticing and offering. Each change is one switch below.
 *
 * VIBE_NOTICE_VARIANT=off restores the earlier texts, for lab comparison;
 * VIBE_NOTICE_OFF=name1,name2 turns off just the named changes. Both are read
 * ONLY when /vibe is a server on this machine (a loopback API URL): a real
 * account always gets the current texts.
 */

const NOTICE = {
  agentHereLine: true,      // 1. the agent's here-line: longer lines, "· open line"
  hereRelevance: true,      // 2. the here-line may be acted on when the work touches someone
  triggers: true,           // 3. ask-before-guessing, bump-before-another-fix, results that touch someone
  offerIsDraft: true,       // 4. the offer is the draft (vibe_prepare), not a question in prose
  replyFromProject: true,   // 5. a reply may come from the project's files, not only this session
  // Lab 2026-11-21, outside read (BRIEF-13): the reluctance that remained was
  // about bothering someone and about looking clueless.
  quietArrival: true,       // 6. the preview says, truthfully, how the message will reach them
  showYourWork: true,       // 7. a question says what was already checked, then asks one answerable thing
  // Blind judging of 40 before/after cases (BRIEF-10): where the old texts won,
  // it was for these.
  answerFirst: true,        // 8. do what was asked first; an unasked draft never replaces the answer; no re-offer after a decline
  threadFirst: true,        // 9. a new draft to someone shows the last lines of the conversation, so a follow-up says only what is new
  lookBeforeNo: true,       // 10. search the project for the question's terms before saying there is nothing to add
  knownRecipient: true,     // 11. only people listed or named; a guessed handle is made obvious in the preview
  // The voice (BRIEF-15, outside design read, with the owner's rulings): quiet,
  // dry, true. docs/VOICE.md holds the rules.
  voiceCharter: true,       // 12. one sentence on how the agent speaks about /vibe matters
  noticingLine: true,       // 13. an offer leads with one true line on why this person, from their own words
  arrivalHeader: true,      // 14. the person's arrival line: "Note from @x (2m ago), waiting at your pause:"
  emptyStates: true,        // 15. "Nothing waiting." / "Just you in here right now; ..." where the state is known
  itLanded: true,           // 16. a one-line note back when a reply changed the work here, as a draft, once per reply
};

/** The agent's copy of someone's line about what they are working on. The person's copy stays at 48. */
const AGENT_SAYS_MAX = 140;
const PERSON_SAYS_MAX = 48;

function isLoopback(env = process.env) {
  let url = env.VIBE_API_URL;
  if (!url) { try { url = require('./config').getApiUrl(); } catch { return false; } }
  let host;
  try { host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** The names VIBE_NOTICE_OFF lists (comma or space separated), as given. */
function offNames(env = process.env) {
  return String(env.VIBE_NOTICE_OFF || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * True when the named change is on. VIBE_NOTICE_VARIANT=off turns all of them
 * off and VIBE_NOTICE_OFF=a,b just those; either only against a loopback API.
 */
function on(name, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(NOTICE, name) || !NOTICE[name]) return false;
  const all = String(env.VIBE_NOTICE_VARIANT || '').trim().toLowerCase() === 'off';
  const some = offNames(env).includes(name);
  if ((all || some) && isLoopback(env)) return false;
  return true;
}

module.exports = { NOTICE, AGENT_SAYS_MAX, PERSON_SAYS_MAX, isLoopback, on, offNames };
