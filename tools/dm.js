/**
 * vibe dm — Send a direct message
 */

const config = require('../config');
const store = require('../store');
const memory = require('../memory');
const userProfiles = require('../store/profiles');
const patterns = require('../intelligence/patterns');
const { trackMessage, checkBurst } = require('./summarize');
const { requireInit, normalizeHandle, truncate, warning, fetchRelevantUsers, markFirstDmSent, isHereNow } = require('./_shared');
const { actions, formatActions } = require('./_actions');

const definition = {
  name: 'vibe_dm',
  description: "Send a direct message to someone on /vibe. It lands in their session now if they're around, or waits for their next turn — nobody has to be online. Sends exactly the text you give it; /vibe doesn't attach repository or session context.",
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to message (e.g., @alex)'
      },
      message: {
        type: 'string',
        description: 'Your message'
      },
      artifact_slug: {
        type: 'string',
        description: 'Optional artifact slug to share (e.g., "pizza-guide-abc123"). The artifact will be shown as a rich card.'
      },
      payload: {
        type: 'object',
        description: 'Optional structured data (game state, code review, handoff, etc.)'
      },
      reply_to: {
        type: 'string',
        description: 'Optional: Message ID to reply to (creates a threaded reply)'
      },
      tip_amount_cents: {
        type: 'number',
        description: 'Optional: Attach an instant USDC tip (100 = $1, 500 = $5, 1000 = $10)'
      },
      idempotency_key: {
        type: 'string',
        description: 'Optional: a stable key for this exact send, so a retry delivers once. Drafting tools set it; omit when composing by hand.'
      },
      approved_sha256: {
        type: 'string',
        description: 'Optional (#392): hex SHA-256 over UTF-8 of "<recipient>\n<message>" — recipient lowercased without a leading @, message trimmed — binding this send to exactly what the person approved. The server refuses a send that would store anything different. Drafting tools set it.'
      },
      origin: {
        type: 'string',
        description: "How this message came to be. Omit for a normal message you're composing. Pass the value the drafting tool told you to use when sending a draft it produced: 'intro' (vibe_intro), 'stuck_solver' (vibe_weave solve), 'held_half' (a Fable-held reply), 'fable'."
      }
    },
    required: ['handle']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { handle, message, artifact_slug, payload, reply_to, tip_amount_cents, origin, idempotency_key, approved_sha256 } = args;
  const myHandle = config.getHandle();
  const them = normalizeHandle(handle);

  // Route @echo messages to the echo agent
  if (them === 'echo') {
    const echo = require('./echo');
    return echo.handler({ message, anonymous: false });
  }

  if (them === myHandle) {
    return { display: 'You can\'t DM yourself.' };
  }

  // Handle artifact sharing
  let finalPayload = payload;
  if (artifact_slug) {
    try {
      // Fetch artifact from API
      const { getArtifactBySlug } = require('./artifact-view');
      const artifact = await getArtifactBySlug(artifact_slug);

      if (!artifact) {
        return { display: `Artifact not found: ${artifact_slug}` };
      }

      // Create artifact payload
      const protocol = require('../protocol');
      finalPayload = protocol.createArtifactPayload(artifact);
    } catch (error) {
      console.error('Failed to load artifact:', error);
      return { display: `Failed to load artifact: ${error.message}` };
    }
  }

  // Need either message or payload
  if ((!message || message.trim().length === 0) && !finalPayload) {
    return { display: 'Need either a message, artifact, or payload.' };
  }

  // Over-limit messages are REFUSED before any write, never shortened. The old
  // truncate-and-warn wrote a message the sender did not approve; refusal keeps
  // the decision with the sender (matches the server's 400 message_too_long).
  const trimmed = message ? message.trim() : '';
  const MAX_LENGTH = 2000;
  if (trimmed.length > MAX_LENGTH) {
    return {
      display: `Not sent — the message is ${trimmed.length} chars and the limit is ${MAX_LENGTH}. Nothing was delivered; shorten it and send again.`,
      data: { sent: false, definite: true },
    };
  }
  const finalMessage = trimmed;

  // Send typing indicator (shows "typing..." to recipient while message is being sent)
  // Non-blocking - we don't wait for this
  store.sendTypingIndicator(myHandle, them).catch(() => {});

  const result = await store.sendMessage(myHandle, them, finalMessage || null, 'dm', finalPayload, {
    replyTo: reply_to || null,
    idempotencyKey: typeof idempotency_key === 'string' && idempotency_key ? idempotency_key : undefined,
    approvedSha256: typeof approved_sha256 === 'string' && approved_sha256 ? approved_sha256 : undefined,
    // Default to 'composed' (a human wrote it); drafting tools pass their own
    // origin so the network's derived messages are distinguishable in the funnel.
    // 'context_move' is allowlisted on the platform (main 5db38c4b, #392):
    // the host agent prepared it from the active session; the person chose
    // and explicitly sent.
    origin: origin || 'composed',
  });

  // Check for errors.
  //
  // The generic tail — "please try again, check your connection" — used to be appended
  // to EVERY failure, including the ones that already name their own fix. An expired
  // session then read as: run `vibe init`, and also try again, and also check your
  // connection. Three instructions, two of them wrong, at the moment someone's first
  // message failed. docs/ROOM-TONE.md: an error names the fix in the same sentence as
  // the problem — which means not adding a second, contradictory one after it.
  //
  // Errors carrying a specific remedy (auth_expired, not_signed_in, handle_not_found)
  // are shown as-is. Only genuinely unknown failures get the retry hint.
  //
  // A falsy result is a failure too. The store used to return null on a thrown
  // transport error, and `result && result.error` waved it through to "Sent to
  // @x" — a success claim with nothing sent. The store now returns a shaped
  // error for that case; the null guard stays so no future falsy return can
  // ever read as delivery again.
  if (!result || result.error) {
    const REMEDY_CARRYING = new Set([
      'auth_expired', 'not_signed_in', 'auth_failed',
      'handle_not_found', 'self_dm', 'storage_error', 'transport_failed',
    ]);
    const detail = (result && result.message) || "That didn't send — nothing was delivered.";
    // A refusal the server made before writing anything is DEFINITE; a
    // transport or storage failure is not — the write may have committed
    // without a receipt. Drafting tools use this to decide retry vs edit.
    // Only refusals that provably precede any write: no token at all, a
    // recipient that does not exist, self, too long, throttled at the door.
    // An auth error is NOT here: the store retries a 401 with a fresh token,
    // and the outcome of a retried exchange must stay uncertain (codex P2).
    // Narrowed again (codex round 6): the transport may retry a dropped
    // connection internally, so even a server refusal on the final attempt
    // does not prove an earlier attempt wrote nothing. Definite = never
    // reached the network at all.
    // The composition-boundary refusals (#392/#394) are checked before any
    // write and are idempotent on retry (same content → same verdict), so a
    // retried exchange cannot have committed first: definite.
    const DEFINITE = new Set(['not_signed_in', 'self_dm', 'message_too_long', 'approved_content_mismatch', 'approved_sha256_malformed', 'approved_send_unsupported_route', 'private_composition_data', 'idempotency_conflict']);
    return {
      display: (result && REMEDY_CARRYING.has(result.error))
        ? detail
        : `${detail}\n\n_worth one retry — if it keeps failing, say_ \`vibe help troubleshooting\`_._`,
      data: { sent: false, definite: Boolean(result && DEFINITE.has(result.error)) },
    };
  }

  // Mark that this user has sent a DM — silences the first-DM activation nudge
  // (vibe start / vibe who) for good. Durable, idempotent, best-effort.
  markFirstDmSent();

  // Log social pattern (quietly, in background)
  patterns.logMessageSent(them);

  // Record connection in profiles (if first time messaging)
  try {
    const hasConnected = await userProfiles.hasBeenConnected(myHandle, them);
    if (!hasConnected) {
      await userProfiles.recordConnection(myHandle, them, 'first_message');
    }
  } catch (error) {
    // Don't fail the message if profile update fails
    console.warn('Failed to update profile connection:', error);
  }

  // Track for session summary
  const activity = trackMessage(myHandle, them, 'sent');

  // Check for burst (5+ messages in thread)
  const burst = checkBurst();

  let display = `Sent to **@${them}**`;

  // The server receipt, shown so a shortened message can never pass as sent.
  // The first Stage-0 brief was cut on a display surface and "Sent to @x" gave
  // the sender nothing to compare — id, stored length and server time make the
  // success claim verifiable (§4 law 2: never claim a state you have not verified).
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
    if (receiptBits.length) display += `\n_receipt: ${receiptBits.join(' · ')}_`;
  }

  // The demo-path beat this tool exists for: sending to someone who is away.
  // One quiet line that states the delivery model — the message waits, nobody
  // has to be online. Best-effort: presence being unreachable never turns a
  // real send into noise.
  try {
    const room = await store.getActiveUsers();
    const recipient = (room || []).find(u => u.handle === them);
    if (!isHereNow(recipient)) {
      display += `\n_@${them} is away — it'll be waiting on their next turn._`;
    }
  } catch (e) {}

  // Only show payload type indicator (message already visible in tool call)
  if (finalPayload) {
    const payloadType = finalPayload.type || 'data';
    if (payloadType === 'artifact') {
      const icon = finalPayload.template === 'guide' ? '📘' : finalPayload.template === 'learning' ? '💡' : finalPayload.template === 'workspace' ? '🗂️' : '📦';
      display += `\n\n${icon} _Shared artifact: ${finalPayload.title}_`;
    } else {
      display += `\n\n📦 _Includes ${payloadType} payload_`;
    }
  }

  // Execute attached tip if specified
  let tipResult = null;
  if (tip_amount_cents && tip_amount_cents > 0) {
    const token = config.getToken();
    if (token) {
      try {
        const apiUrl = config.getApiUrl();
        // Generate idempotency key to prevent duplicate tips from retries
        const timeBucket = Math.floor(Date.now() / 60000);
        const tipIdempotencyKey = `dm:${myHandle}:${them}:${tip_amount_cents}:${timeBucket}`;

        const tipResponse = await fetch(`${apiUrl}/api/tips/instant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Idempotency-Key': tipIdempotencyKey
          },
          body: JSON.stringify({
            to: them,
            amount_cents: tip_amount_cents,
            message: message ? `${message.substring(0, 50)}...` : null,
            context: { type: 'dm_reply' }
          })
        });

        tipResult = await tipResponse.json();

        if (tipResult.success) {
          const tipAmount = (tip_amount_cents / 100).toFixed(0);
          display += `\n\n💸 _Tipped $${tipAmount} USDC — [view tx](${tipResult.explorer_url})_`;
        } else {
          display += `\n\n⚠️ _Tip failed: ${tipResult.message || 'Unknown error'}_`;
        }
      } catch (tipError) {
        console.warn('[dm] Tip execution failed:', tipError.message);
        display += `\n\n⚠️ _Tip failed: ${tipError.message}_`;
      }
    }
  }

  // Burst notification (5+ messages in one thread)
  if (burst.triggered && burst.thread === them) {
    display += `\n\n💬 _${burst.count} messages with @${them} — say "summarize" when done_`;
  }

  // Build response with optional hints for structured flows
  // Structured outcome for tools that send on a person's behalf: the display
  // text is for the human, `data.sent` is the fact (never regex the prose).
  const response = { display, data: { sent: true, message_id: result.id || null } };

  // An ordinary DM to them supersedes any context-move binding on the
  // thread: what they say next is a reply to THIS, not to the older draft.
  if (origin !== 'context_move') { try { require('./moves').clearReturnBinding(them); } catch (e) {} }

  // Check if we have any memories for this person
  const memoryCount = memory.count(them);

  // Suggest saving a memory if we don't have any
  if (memoryCount === 0) {
    response.hint = 'offer_memory_save';
    response.for_handle = them;
    response.suggestion = `Remember something about @${them} for next time?`;
  }
  // Suggest a follow-up after burst of messages
  else if (burst.triggered && burst.thread === them) {
    response.hint = 'suggest_followup';
    response.for_handle = them;
    response.message_count = burst.count;
  }

  // Add guided mode actions
  response.actions = formatActions(actions.afterDm(them));

  // Fetch DM suggestions (async, non-blocking for response)
  // This adds "You might want to message..." suggestions
  try {
    const suggestions = await fetchRelevantUsers(myHandle, 'dm_suggest', 3);
    if (suggestions && suggestions.matches && suggestions.matches.length > 0) {
      // Filter out the person we just messaged
      const others = suggestions.matches.filter(m => m.handle !== them);
      if (others.length > 0) {
        response.dm_suggestions = others.map(m => ({
          handle: m.handle,
          building: m.building,
          reasons: m.reasons?.slice(0, 2) || []
        }));
      }
    }
  } catch (e) {
    // Don't fail DM if suggestions fail
    console.log('[dm] dm_suggest fetch error:', e.message);
  }

  return response;
}

module.exports = { definition, handler };
