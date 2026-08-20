/**
 * ask-resolver — the ONE definition of "has this person answered yet".
 *
 * A pure function over a thread: no store, no clock, no transport. That is what lets the
 * stdio server and the hosted endpoint (stateless per request) share one rule instead of
 * each interpreting "answered" for itself.
 *
 * ORDERING IS A DATABASE CURSOR, NOT A TIMESTAMP (migration 086). Every earlier version
 * of this rule compared `created_at` and broke tie-cases with the message id, and both
 * are unordered in this schema:
 *   * created_at is `timestamp without time zone`, so ties happen — and treating a
 *     DISTINCT id at the same millisecond as "later" let a message that existed BEFORE
 *     the question answer it;
 *   * ids are text with a random suffix, so id comparison is a coin flip;
 *   * import/replication can assign a timestamp that precedes a logically earlier row,
 *     so a genuine answer sorts before the question and is ignored forever;
 *   * a missing timestamp meant a real answer could never resolve at all.
 * `seq` is monotonic and unique, assigned by Postgres. "After the question" is
 * `seq > watermarkSeq`. Wall-clock keeps exactly one job: the deadline bound.
 *
 * CORRELATION, strongest first:
 *   1. `reply_to` pointing at our question — definitive, so concurrent asks cannot collide.
 *   2. otherwise the first message from them after the cursor — which is only safe when
 *      one ask per target is outstanding. The durable store enforces that with a partial
 *      unique index. A human replying with an ordinary DM cannot be made to correlate,
 *      so this fallback must exist; it is explicitly "first subsequent DM", and callers
 *      that need certainty should require the threaded case.
 */

'use strict';

const { canonicalHandle } = require('./handle');

/** Monotonic cursor, or null when a row predates migration 086. */
function seqOf(m) {
  const v = m?.seq ?? m?.sequence;
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);       // BIGSERIAL arrives as a string
  return Number.isFinite(n) ? n : null;
}

/** Wall-clock, for the deadline bound ONLY. Date instances keep their milliseconds —
 *  Date.parse(dateObject) stringifies and silently truncates them. */
function timeOf(m) {
  const v = m?.createdAt ?? m?.created_at ?? m?.timestamp ?? m?.ts;
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

const idOf = (m) => String(m?.id ?? m?.messageId ?? m?.message_id ?? '');
const replyToOf = (m) => String(m?.replyTo ?? m?.reply_to ?? m?.reply_to_id ?? '');

/**
 * The reply that answers the question, or null.
 *
 * @param {Array<object>} thread messages in a conversation, any order
 * @param {object} spec
 * @param {string} spec.target            whose reply we are waiting for
 * @param {number|string} spec.watermarkSeq  `seq` of the question row (REQUIRED)
 * @param {string} [spec.watermarkId]     id of the question row
 * @param {number|string|Date} [spec.until] deadline; a reply after it cannot complete the
 *   task. Bounding the WINDOW is what makes correctness independent of when someone polls:
 *   a late reply never completes, and a timely reply polled late still does.
 * @returns {object|null}
 */
function resolveAskReply(thread, { target, watermarkSeq, watermarkId, until } = {}) {
  const who = canonicalHandle(target);
  if (!who) return null;

  const mark = seqOf({ seq: watermarkSeq });
  if (mark == null) return null;          // no cursor ⇒ never resolve, never guess

  const ceiling = until == null ? Infinity : timeOf({ ts: until });
  if (ceiling == null) return null;       // an unparseable bound is not a bound

  const theirs = (Array.isArray(thread) ? thread : []).filter((m) => {
    if (canonicalHandle(m?.from ?? m?.from_handle) !== who) return false;   // their words only
    const s = seqOf(m);
    if (s == null || s <= mark) return false;        // strictly after the question
    if (idOf(m) && idOf(m) === String(watermarkId || '')) return false;     // not the question
    const t = timeOf(m);
    return t == null ? true : t <= ceiling;          // no timestamp ⇒ trust the cursor
  });

  // 1. Definitive: they replied TO our question.
  const threaded = theirs.filter((m) => watermarkId && replyToOf(m) === String(watermarkId));
  const pool = threaded.length ? threaded : theirs;

  // Total order, because seq is unique — no tiebreaker needed, and therefore no
  // locale-dependent comparison that could make two runtimes disagree.
  pool.sort((a, b) => seqOf(a) - seqOf(b));

  // FIRST reply wins, even if it is "one sec": deciding which reply is "the real answer"
  // needs a model in the loop, and the agent can ask again. Documented intent.
  return pool[0] || null;
}

/** Plain text of a reply, whatever the store calls the field. */
const replyText = (m) => String(m?.body ?? m?.text ?? m?.message ?? '');

module.exports = { resolveAskReply, replyText, canonicalHandle };
