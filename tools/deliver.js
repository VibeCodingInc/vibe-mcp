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
const { requireInit, normalizeHandle, isHereNow } = require('./_shared');

const MAX_LENGTH = 2000;

// Refusals that provably precede any write. A transport or storage failure is
// not here: the write may have committed without a receipt, and the transport
// may have retried, so the outcome stays uncertain. Drafts use this to decide
// between "edit and resend" and "retry the same text or cancel".
const DEFINITE = new Set(['not_signed_in', 'self_dm', 'message_too_long', 'approved_content_mismatch',
  'approved_sha256_malformed', 'approved_send_unsupported_route', 'private_composition_data', 'idempotency_conflict']);
// Errors whose message already names the fix; they get no generic retry hint.
const REMEDY_CARRYING = new Set(['auth_expired', 'not_signed_in', 'auth_failed', 'handle_not_found',
  'self_dm', 'storage_error', 'transport_failed']);

/**
 * @param {{to: string, message: string, replyTo?: string|null, origin?: string,
 *          idempotencyKey?: string, approvedSha256?: string}} m
 */
async function deliver(m) {
  const initCheck = requireInit();
  if (initCheck) return { ...initCheck, data: { sent: false, definite: true } };

  const me = config.getHandle();
  const them = normalizeHandle(m.to);
  if (!them) return { display: 'Nothing sent. Who is it for?', data: { sent: false, definite: true } };
  if (them === me) return { display: "You can't message yourself.", data: { sent: false, definite: true } };

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
    // 'composed': the person wrote it. 'context_move': their agent prepared it
    // from the active session and the person chose Send.
    origin: m.origin || 'composed',
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
  try {
    const room = await store.getActiveUsers();
    if (!isHereNow((room || []).find((u) => u.handle === them))) {
      display += `\n_@${them} is not in a session right now. It reaches them when they next are._`;
    }
  } catch (e) {}

  // Writing to someone is what lets their answer reach you mid-work (reach.js).
  require('../reach').know(them);

  return { display, data: { sent: true, message_id: result.id || null } };
}

module.exports = { deliver, MAX_LENGTH };
