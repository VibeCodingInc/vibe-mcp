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
  emptyStates: true,        // 15. "Nothing waiting." / "Nobody else shows as here right now; ..." where the state is known
  itLanded: true,           // 16. a one-line note back when a reply changed the work here, as a draft, once per reply
  // The first five minutes (BRIEF-20, outside walk-through of a newcomer).
  setupReceipt: true,       // 17. setup ends with notes already waiting (handles only, one bounded read) and "open a fresh session"
  landedReminder: true,     // 18. after a reply to the person's own message was shown (by the arrival hook or at session start), prompts in that session remind the agent (agent only, at most 3, 2 hours)
  confirmLead: true,        // 19. the Send box's fixed first line reads as the confirmation of the send: "Confirm: send to @ben? (...)"
  landedAsDraft: true,      // 20. the note-back hook and reminder say: open it as a draft at the end of that reply, do not ask in prose first
  // Outside review of 11 real notes back (2026-11-22): the worst smuggled a new
  // request into the thank-you, gave an order, invented a number, or reported
  // no change at all; the best were receipts of what changed.
  landedReceipt: true,      // 21. a note back is a one-sentence receipt of what changed (not-live said, no question, no request); vibe_prepare refuses a question mark in one
  // The people writing to each other build software: a note saying "pattern is
  // now ^[0-9]{5,8}$" reached the other side as ^❲0-9❳{5,8}$ (2026-11-22).
  codeFidelity: true,       // 22. a message body reaches the agent in a nonce fence and the person at the end of its line, byte-for-byte for code characters (incoming.js fence, inertLine)
  // The invited person's first minute (audit 2026-11-22, invite-first-minute).
  heldCarriesCode: true,    // 23. a Keep's pass-on command carries the held message's invitation code (printed before any link), and the sentence says what delivers it
  inviteQuestion: true,     // 24. vibe_prepare {invite: true}: one message on a new invite line, previewed, turn-checked and boxed like a Keep, delivered once to whoever joins with it
  invitedEmptyState: true,  // 25. session start names the inviter while nothing has passed between them; "Rare moment" only with a conversation; agents left out of the stranger count
};

/**
 * landedReceipt: what a note back is (outside review of 11 real notes,
 * 2026-11-22). LANDED_RECEIPT is the full rule (SERVER_INSTRUCTIONS,
 * hosts/vibe-command.md); LANDED_RECEIPT_SHORT rides on the note-back hook and
 * reminder (arrival.js, hooks/arrival-hook.cjs keeps its own copy, tested equal)
 * and the kind field. LANDED_RECEIPT_EXAMPLE is one of the reviewed best.
 */
const LANDED_RECEIPT = 'A note back is a one-sentence receipt of what changed on the person\'s side: the concrete file, setting or decision that was actually updated, saying "not deployed yet" or "local only" when it is not live. It uses only numbers and names that are in the person\'s files or in the answer itself, and no invented feelings or claimed savings. It carries no question, no request and no instruction to the other person: if the person also needs something more from them, that is a separate ordinary draft, offered separately. If nothing changed (the answer only agreed with what they had), there is no note back.';
const LANDED_RECEIPT_SHORT = 'The note is a one-sentence receipt of what changed on the person\'s side (the file, setting or decision actually updated; say "not deployed yet" or "local only" when it is not live), with only numbers and names from their files or the answer, and no question, request or instruction to them; anything more the person needs from them is a separate ordinary draft. If nothing changed, no note back.';
const LANDED_RECEIPT_EXAMPLE = 'Your bare-ID answer landed: issue_refund pattern is now ^[0-9]{5,8}$ and the ORD- rule is out of the prompt. Not published to staging yet.';

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

module.exports = { NOTICE, AGENT_SAYS_MAX, PERSON_SAYS_MAX, LANDED_RECEIPT, LANDED_RECEIPT_SHORT, LANDED_RECEIPT_EXAMPLE, isLoopback, on, offNames };
