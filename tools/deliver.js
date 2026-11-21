/**
 * deliver — the one way a message leaves this machine.
 *
 * Every send, prepared or typed, goes through here. It sends exactly the text
 * it is given, refuses rather than shortens, and reports the outcome as a
 * fact (`data.sent`, `data.definite`) beside the words shown to the person,
 * so no caller ever has to read prose to learn what happened.
 */

'use strict';

const config = require('../config');
const store = require('../store');
const { requireInit, isHereNow } = require('./_shared');
const { canonicalHandle } = require('../protocol/handle');

const MAX_LENGTH = 2000;

// Refusals that provably precede any write. A transport or storage failure is
// not here: the write may have committed without a receipt, and the transport
// may have retried, so the outcome stays uncertain. Drafts use this to decide
// between "edit and resend" and "retry the same text or cancel".
const DEFINITE = new Set(['not_signed_in', 'self_dm', 'message_too_long', 'approved_content_mismatch',
  'approved_sha256_malformed', 'approved_send_unsupported_route', 'private_composition_data', 'idempotency_conflict']);
// Errors whose message already names the fix; they get no generic retry hint.
// An unreadable reply is one of them: it may have been stored, and a typed
// resend carries a fresh key, so "worth one retry" could deliver it twice.
const REMEDY_CARRYING = new Set(['auth_expired', 'not_signed_in', 'auth_failed', 'handle_not_found',
  'self_dm', 'storage_error', 'transport_failed', 'unconfirmed_response']);

/**
 * @param {{to: string, message: string, replyTo?: string|null, origin?: string,
 *          idempotencyKey?: string, approvedSha256?: string}} m
 */
async function deliver(m) {
  const initCheck = requireInit();
  if (initCheck) return { ...initCheck, data: { sent: false, definite: true } };

  // Both sides in the one canonical form, so a padded or prefixed "@me" is
  // still recognised as you (protocol/handle.js).
  const me = config.getHandle();
  const them = canonicalHandle(typeof m.to === 'string' ? m.to : String(m.to || ''));
  if (!them) return { display: 'Nothing sent. Who is it for?', data: { sent: false, definite: true } };
  if (them === canonicalHandle(me || '')) return { display: "You can't message yourself.", data: { sent: false, definite: true } };

  const text = typeof m.message === 'string' ? m.message.trim() : '';
  if (!text) return { display: 'Nothing sent. The message is empty.', data: { sent: false, definite: true } };
  if (text.length > MAX_LENGTH) {
    return {
      display: `Not sent. The message is ${text.length} chars and the limit is ${MAX_LENGTH}. Nothing was delivered; shorten it and send again.`,
      data: { sent: false, definite: true },
    };
  }

  const result = await store.sendMessage(me, them, text, 'dm', null, {
    replyTo: m.replyTo || null,
    idempotencyKey: typeof m.idempotencyKey === 'string' && m.idempotencyKey ? m.idempotencyKey : undefined,
    approvedSha256: typeof m.approvedSha256 === 'string' && m.approvedSha256 ? m.approvedSha256 : undefined,
    // WHO DECIDED TO SEND, said truthfully. This is the one place every message
    // passes, so it is the one place that decides:
    //   'agent_self'    this session IS an agent, signed in as itself. No person
    //                   chose Send, whichever tool path the message took.
    //   'agent_line'    a person's agent sent it over an open line, unread by them
    //                   (set by tools/line.js).
    //   'context_move'  the agent prepared it and the person chose Send.
    //   'composed'      the person's own words.
    // Until the service accepts the two agent values it drops them to "unlabelled",
    // which is still true. The old behaviour recorded them as 'composed', which the
    // service defines as "a human wrote it".
    origin: require('../agent-auth').isAgent() ? 'agent_self' : (m.origin || 'composed'),
  });

  // A falsy result is a failure too: nothing may read as delivery without a receipt.
  if (!result || result.error) {
    const detail = (result && result.message) || "That didn't send. Nothing was delivered.";
    return {
      display: (result && REMEDY_CARRYING.has(result.error)) ? detail : `${detail}\n\n_Worth one retry._`,
      data: { sent: false, definite: Boolean(result && DEFINITE.has(result.error)) },
    };
  }

  // The server's receipt, shown so a changed message can never pass as sent.
  let display = `Sent to **@${them}**`;
  const storedLength = result.storedLength ?? (typeof result.body === 'string' ? result.body.length : null);
  const receipt = [];
  if (result.id) receipt.push(result.id);
  if (storedLength != null) {
    receipt.push(`${storedLength} chars stored`);
    if (storedLength !== text.length) {
      display += `\nlength mismatch: sent ${text.length} chars, server stored ${storedLength}. The stored copy is not what you approved.`;
    }
  }
  const ts = result.serverTimestamp || result.created_at;
  if (ts) receipt.push(String(ts));
  if (receipt.length) display += `\n_receipt: ${receipt.join(' · ')}_`;

  // Nobody has to be online. Say so once, when it applies; presence being
  // unreadable never turns a real send into noise.
  // Only a presence read that succeeded can say they are not here; a failed
  // one says nothing (getActiveUsers flattens a failure to an empty room).
  try {
    const room = await store.getActiveUsersResult();
    if (room && room.ok === true && !isHereNow((room.users || []).find((u) => u && u.handle === them))) {
      display += `\n_@${them} is not in a session right now. It reaches them when they next are._`;
    }
  } catch (e) {}

  // Writing to someone is what lets their answer reach you mid-work (reach.js).
  require('../reach').know(them);
  // A message the person just answered has been seen: it must never then be
  // announced as arriving (presence.js releases parked messages on a send).
  if (m.replyTo) { try { require('../arrival').claim(m.replyTo); } catch (e) {} }

  return { display, data: { sent: true, message_id: result.id || null } };
}

module.exports = { deliver, MAX_LENGTH };
