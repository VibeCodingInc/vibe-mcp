/**
 * vibe reply — reply to a specific message by its visible #id (linked), or continue a named thread unlinked; never guesses the newest.
 *
 * Streamlined flow: one command instead of inbox → open → dm
 */

const config = require('../config');
const store = require('../store');
const patterns = require('../intelligence/patterns');
const userProfiles = require('../store/profiles');
const { trackMessage } = require('./summarize');
const { requireInit, normalizeHandle, truncate, warning, fetchRelevantUsers } = require('./_shared');
const { actions, formatActions } = require('./_actions');

const definition = {
  name: 'vibe_reply',
  description: 'Reply to a specific message by its visible #id (reply_to) — the reply is linked to exactly that message. Or continue a named thread unlinked with `to`. Never guesses: with neither, it lists the visible ids instead of sending.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Your reply message'
      },
      to: {
        type: 'string',
        description: 'Optional: continue a named thread unlinked (e.g., @alex). With neither `to` nor `reply_to`, nothing is sent — the visible #ids are listed instead.'
      },
      reply_to: {
        type: 'string',
        description: 'Optional: the exact message ID being answered (the #id shown beside messages in the thread view). When several messages could be the target, ask the human which one — NEVER silently pick the newest. Omit for an ordinary unlinked reply.'
      }
    },
    required: ['message']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { message, to, reply_to } = args;
  const myHandle = config.getHandle();

  if (!message || message.trim().length === 0) {
    return { display: 'Need a message to reply with.' };
  }

  let targetHandle;
  let threadContext = null;

  // THE TARGET IS NAMED, NEVER GUESSED (first-five-minutes repair). A reply
  // consumes the visible #id exactly; `to` alone continues a named thread
  // unlinked; nothing at all is refused WITH the candidates — the old
  // "first unread thread wins" default was the guess this verb's own schema
  // forbids.
  if (to) {
    targetHandle = normalizeHandle(to);
  } else if (reply_to) {
    // Resolve the thread that holds this id from the inbox (newest message
    // per thread is served with its id); fall back to a bounded scan of the
    // most recent threads for an older id.
    const threads = (await store.getInbox(myHandle)) || [];
    let owner = threads.find((t) => t.lastMessageId === reply_to);
    if (!owner) {
      for (const t of threads.slice(0, 5)) {
        try {
          const full = await store.getThread(myHandle, t.handle);
          if ((full || []).some((m) => m.id === reply_to)) { owner = t; break; }
        } catch {}
      }
    }
    if (!owner) {
      return {
        display: `Not sent — no message #${reply_to} in your recent threads, and I won't guess. Say \`vibe inbox\` to see the ids.`,
      };
    }
    targetHandle = owner.handle;
  } else {
    const threads = (await store.getInbox(myHandle)) || [];
    if (threads.length === 0) {
      return {
        display: '📭 No messages to reply to.\n\nUse `vibe dm @someone "message"` to start a conversation.',
        actions: formatActions(actions.recommendedConnections([]))
      };
    }
    const candidates = threads
      .filter((t) => t.lastMessageId)
      .slice(0, 6)
      .map((t) => `  #${t.lastMessageId} — @${t.handle}${t.unread ? ` (${t.unread} unread)` : ''}: "${truncate(t.lastMessage || '', 48)}"`)
      .join('\n');
    return {
      display: `Not sent — which message are you answering? I won't pick the newest for you.\n${candidates || '  (no ids in the loaded inbox)'}\n\n_reply exactly with_ reply_to: "<id>" _— or continue a thread unlinked with_ to: "@handle"`,
    };
  }

  // Can't reply to yourself
  if (targetHandle === myHandle) {
    return { display: 'You can\'t DM yourself.' };
  }

  // Route @echo messages to the echo agent
  if (targetHandle === 'echo') {
    const echo = require('./echo');
    return echo.handler({ message, anonymous: false });
  }

  // Over-limit replies are REFUSED before any write, never shortened — same
  // contract as dm.js and the server's 400 message_too_long.
  const MAX_LENGTH = 2000;
  const trimmed = message.trim();
  if (trimmed.length > MAX_LENGTH) {
    return {
      display: `Not sent — the reply is ${trimmed.length} chars and the limit is ${MAX_LENGTH}. Nothing was delivered; shorten it and send again.`,
    };
  }
  const finalMessage = trimmed;

  // Explicit reply target: the ID must exist in this thread. An unknown ID is
  // refused WITH the candidates — never corrected to "probably the newest",
  // which is exactly the mis-association Pass 3A demonstrated live. No target
  // at all stays an ordinary unlinked message (the truthful default).
  // DEFENSE-IN-DEPTH, not authority: the server validates replyTo at the
  // write boundary (exists ∧ same conversation ∧ not deleted) and refuses
  // with a stable invalid_reply_target — this local check just gives a better
  // error (with candidates) before a round-trip.
  let quotedParent = null;
  if (reply_to) {
    const thread = await store.getThread(myHandle, targetHandle);
    const target = (thread || []).find((m) => m.id === reply_to);
    if (!target) {
      const candidates = (thread || [])
        .filter((m) => m.id)
        .slice(-6)
        .map((m) => `  #${m.id} — ${m.from === myHandle ? 'you' : '@' + m.from}: "${truncate(m.body || '', 48)}"`)
        .join('\n');
      return {
        display: `Not sent — no message #${reply_to} in this thread, and I won't guess the target.\nWhich message are you answering?\n${candidates || '  (no messages with IDs in the loaded window)'}`,
      };
    }
    quotedParent = target;
  }

  // Send typing indicator (shows "typing..." to recipient)
  store.sendTypingIndicator(myHandle, targetHandle).catch(() => {});

  // Send the message — reply_to writes the EXISTING reply_to field; the
  // server's reply_to_id is the only authoritative link (no post-hoc linking).
  const result = await store.sendMessage(myHandle, targetHandle, finalMessage, 'dm', null, {
    replyTo: reply_to || null,
  });

  // Same contract as dm.js: a falsy result is a failure (the store used to
  // return null on transport errors and this claimed "✓ Replied"), errors that
  // carry their own remedy are shown as-is, and everything else gets exactly
  // one next action — not "please try again" stacked on top of a fix.
  if (!result || result.error) {
    const REMEDY_CARRYING = new Set([
      'auth_expired', 'not_signed_in', 'auth_failed',
      'handle_not_found', 'self_dm', 'storage_error', 'transport_failed',
      // The server's write-boundary refusal (target missing, foreign, or
      // deleted — one uniform message, no existence oracle). Retrying the
      // same target cannot help, so the refusal is shown as-is.
      'invalid_reply_target',
    ]);
    const detail = (result && result.message) || "That reply didn't send — nothing was delivered.";
    return {
      display: (result && REMEDY_CARRYING.has(result.error))
        ? detail
        : `${detail}\n\n_worth one retry — if it keeps failing, say_ \`vibe help troubleshooting\`_._`,
    };
  }

  // Mark the thread as read since we're replying
  try {
    // A refusal is not an exception, so `catch` alone could not see it.
    const marked = await store.markThreadRead(myHandle, targetHandle);
    if (marked && marked.success === false) {
      console.warn('[reply] thread not marked read:', marked.error);
    }
  } catch (e) {
    // Non-fatal - continue
    console.warn('[reply] Failed to mark thread as read:', e.message);
  }

  // Log social pattern
  patterns.logMessageSent(targetHandle);

  // Record connection if first time
  try {
    const hasConnected = await userProfiles.hasBeenConnected(myHandle, targetHandle);
    if (!hasConnected) {
      await userProfiles.recordConnection(myHandle, targetHandle, 'first_message');
    }
  } catch (e) {
    console.warn('[reply] Failed to update profile connection:', e);
  }

  // Track for session summary
  trackMessage(myHandle, targetHandle, 'sent');

  // Build response
  let display = `✓ Replied to **@${targetHandle}**`;
  if (quotedParent) {
    display += `\n↩ replying to #${quotedParent.id} ${quotedParent.from === myHandle ? 'you' : '@' + quotedParent.from}: "${truncate(quotedParent.body || '', 48)}"`;
  }

  // Same receipt as dm.js: id · chars stored · server time, with a loud
  // mismatch warning — a shortened message can never pass as sent.
  {
    const storedLength = result.storedLength
      ?? (typeof result.body === 'string' ? result.body.length : null);
    const receiptBits = [];
    if (result.id) receiptBits.push(result.id);
    if (storedLength != null) {
      receiptBits.push(`${storedLength} chars stored`);
      if (finalMessage && storedLength !== finalMessage.length) {
        display += `\n⚠️ length mismatch: sent ${finalMessage.length} chars, server stored ${storedLength} — the stored copy is not what you approved.`;
      }
    }
    const ts = result.serverTimestamp || result.created_at;
    if (ts) receiptBits.push(String(ts));
    if (reply_to) receiptBits.push(`replying to ${reply_to}`);
    if (receiptBits.length) display += `\n_receipt: ${receiptBits.join(' · ')}_`;
  }

  if (threadContext) {
    display += `\n\n_${threadContext.unreadCount} message${threadContext.unreadCount > 1 ? 's' : ''} marked as read_`;
  }

  // Check for more unread
  const remainingThreads = await store.getInbox(myHandle);
  const stillUnread = remainingThreads.filter(t => t.unread > 0 && t.handle !== targetHandle);

  if (stillUnread.length > 0) {
    const nextHandle = stillUnread[0].handle;
    const totalUnread = stillUnread.reduce((sum, t) => sum + t.unread, 0);
    display += `\n\n📬 ${totalUnread} more unread from ${stillUnread.map(t => `@${t.handle}`).slice(0, 3).join(', ')}`;
    const nextId = stillUnread[0].lastMessageId;
    display += nextId
      ? `\n_Reply to @${nextHandle} exactly: \`vibe reply\` with reply_to: "${nextId}"_`
      : `\n_Open @${nextHandle}'s thread with \`vibe inbox @${nextHandle}\` to reply to a specific message_`;
  }

  // Build response with actions
  const response = { display };

  // Suggest follow-up actions
  response.actions = formatActions(actions.afterDm(targetHandle));

  return response;
}

module.exports = { definition, handler };
