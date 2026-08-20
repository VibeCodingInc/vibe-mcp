/**
 * vibe weave — The Weave substrate + "Fable holds your half" (RFC_THE_WEAVE.md).
 *
 * This is NOT a new place to go. You never open anything. Once per session your
 * agent quietly attaches your *strand* — a distilled signal of what you're in the
 * middle of ({building, stuck_on, last_ship, voice_sample, tags}) — and the magic
 * is what the loom does back: it emits *moments* into surfaces you already touch
 * (vibe_start / vibe_who), like carrying your half of a conversation forward when
 * a reply lands after you've moved on.
 *
 * Two things live here:
 *   Spec 1 — vibe_weave(action:'attach'): spin your strand onto the loom.
 *   Spec 2 — the "held half": when someone replied to a thread and you haven't
 *            answered, Fable (your in-session model) drafts your reply in your
 *            voice and you send it with one word. NEVER auto-sends.
 *
 * The draft-then-one-word-confirm pattern is the hard-won vibe_intro lesson:
 * Fable drafts, the human sends. Consent stays on the human's side.
 */

const config = require('../config');
const store = require('../store');
const { renderIncoming } = require('../incoming');
const { requireInit, normalizeHandle, formatTimeAgo, truncate } = require('./_shared');

const definition = {
  name: 'vibe_weave',
  description:
    "Attach this session's *strand* to the Weave so Fable can bring social moments INTO your terminal (no new place to visit). " +
    'Call this once, right after vibe_init/vibe_start succeeds. ' +
    'Spin the strand from what the user is ACTUALLY doing this session, inferred from their files/project/recent work — not a status they typed. ' +
    'Fields: `building` (one specific line on the current work), `stuck_on` (the wall they keep hitting, if any — an error signature or repeated symptom), `last_ship` (most recent thing that landed), `voice_sample` (2-3 sentences in the user\'s actual writing voice, so Fable can later draft replies that sound like them), `tags` (a few topic keywords). ' +
    'Everything is a distillation — never send raw source. ' +
    'Use `action:"held"` to check whether anyone replied to a thread the user left hanging; if so it hands you the context to draft their half. ' +
    'Use `action:"stuck"` when the user is blocked: it returns builders whose live work or shipped history may be the SAME problem already solved — you judge which candidate is truly the same problem, surface the shape of their fix, and offer a warm intro thread.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['attach', 'held', 'stuck', 'quiet'],
        description:
          "'attach' (default): spin/refresh your strand. 'held': surface any conversation where someone replied and you haven't answered, so you can draft the user's half. 'stuck': find builders whose live work or shipped history is the same problem the user is blocked on (pass the wall as `stuck_on`, or it falls back to the attached strand). 'quiet': leave the weave (removes your strand).",
      },
      building: {
        type: 'string',
        description: 'One specific line on what the user is working on this session (inferred from their real context).',
      },
      stuck_on: {
        type: 'string',
        description: "The wall the user keeps hitting, if any — an error signature or repeated symptom. Empty if they're cruising.",
      },
      last_ship: {
        type: 'string',
        description: 'The most recent thing the user shipped/landed this session.',
      },
      voice_sample: {
        type: 'string',
        description: "2-3 sentences in the user's actual voice, so Fable can later draft messages that sound like them.",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'A few topic keywords (e.g. ["oauth","nextjs","postgres"]).',
      },
      posture: {
        type: 'string',
        enum: ['full', 'receive', 'quiet'],
        description: "'full' (default): contribute + receive moments. 'receive': receive-only, expose nothing. 'quiet': opt out entirely.",
      },
    },
    required: [],
  },
};

function apiBase() {
  return config.getApiUrl();
}

// POST the strand digest to the loom. Actor is derived server-side from the
// token — we send only the distillation.
async function postStrand({ digest, posture }) {
  const token = config.getAuthToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const resp = await fetch(`${apiBase()}/api/weave/strand`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ digest, posture }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: json.error || `http_${resp.status}` };
    return { ok: true, data: json.data || {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Ask the loom for candidate SOLVERS — builders whose live work or shipped
// history may be the same problem the user is stuck on. Actor derived server-side
// from the token; we send only the stuck_on signature (or let the server fall
// back to the user's own stored strand when we omit it).
async function postSolve({ stuck_on } = {}) {
  const token = config.getAuthToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const resp = await fetch(`${apiBase()}/api/weave/solve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(stuck_on ? { stuck_on } : {}),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: json.error || `http_${resp.status}` };
    return { ok: true, data: json.data || {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Find conversations where the other person replied and the user hasn't answered
 * yet — the "you moved on, a reply landed" signal. Uses unread count as the
 * proxy (they messaged, you haven't opened/replied). Returns the freshest one
 * with the actual inbound text pulled from the thread, or null.
 *
 * Exported so vibe_start can surface the moment inline without re-implementing it.
 */
async function findHeldHalf(myHandle) {
  let inbox = [];
  try {
    inbox = (await store.getInbox(myHandle)) || [];
  } catch {
    return null;
  }
  // Threads with something waiting for your half, freshest first.
  const waiting = inbox
    .filter((t) => t && t.handle && (t.unread || 0) > 0)
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  if (waiting.length === 0) return null;

  const top = waiting[0];
  const them = normalizeHandle(top.handle);

  // Pull the thread to get the actual inbound message + a little context.
  let inboundBody = top.lastMessage || '';
  let inboundAt = top.lastTimestamp || null;
  let myLast = '';
  try {
    const thread = await store.getThread(myHandle, them);
    if (Array.isArray(thread) && thread.length) {
      const lastReceived = [...thread].reverse().find((m) => m.direction === 'received');
      if (lastReceived) {
        inboundBody = lastReceived.body || inboundBody;
        inboundAt = lastReceived.timestamp || inboundAt;
      }
      const lastSent = [...thread].reverse().find((m) => m.direction === 'sent');
      if (lastSent) myLast = lastSent.body || '';
    }
  } catch {
    // best-effort — the inbox preview is enough to surface the moment
  }

  if (!inboundBody) return null;
  return {
    handle: them,
    inbound: inboundBody,
    inboundAgo: inboundAt ? formatTimeAgo(inboundAt) : 'recently',
    myLast,
    otherWaiting: waiting.length - 1,
  };
}

/**
 * Render the held-half moment as a markdown block for vibe_start, or '' when
 * there's nothing to hold. This is the wedge: the model reading this block IS
 * Fable — it drafts the user's reply in their voice and offers one-word send.
 */
async function weaveMoment(myHandle) {
  const held = await findHeldHalf(myHandle);
  if (!held) return '';
  // This block renders ANOTHER PERSON'S WORDS into a model's context, and it used to
  // do it as a bare markdown blockquote followed by trusted copy saying "Draft it
  // now" and "deliver with vibe_dm". That is untrusted text sitting adjacent to an
  // instruction to compose and send — the strongest injection shape in this codebase,
  // and it fired from DEFAULT vibe_start, not from an opt-in tool.
  //
  // Two changes, both required:
  //   1. the body goes through the shared envelope (framing BEFORE content, markers
  //      neutralized) like every other inbound message;
  //   2. nothing here tells the model to draft or send. Drafting is a thing the USER
  //      asks for — `vibe weave` still does it on request. A notification may say
  //      someone is waiting; it may not act on what they wrote.
  const block =
    renderIncoming([{ from: held.handle, text: held.inbound }], {
      replyTo: held.handle,
      threadHint: true,
    }) +
    `\n_@${held.handle} is waiting on your reply (${held.inboundAgo}). Say \`vibe weave\` if you want help drafting one._`;
  const more = held.otherWaiting > 0
    ? `\n_(+${held.otherWaiting} more thread${held.otherWaiting > 1 ? 's' : ''} waiting on you.)_`
    : '';
  return block + more;
}

async function handler(args = {}) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const action = args.action || 'attach';

  // ── Held-half: surface a conversation waiting on the user's reply ─────────
  if (action === 'held') {
    const held = await findHeldHalf(myHandle);
    if (!held) {
      return {
        display:
          "Nothing waiting on your half right now — every thread's answered. " +
          '`vibe who` to see who else is around.',
      };
    }
    return {
      display:
        `🧵 **@${held.handle} replied ${held.inboundAgo} — you haven't answered:**\n` +
        `> ${truncate(held.inbound, 280)}\n\n` +
        `Draft @${myHandle}'s reply in their voice from what they were building, show it, then ask: ` +
        `**send it (y) · edit · let it sit**. On yes, send with \`vibe_dm @${held.handle}\` (origin: "held_half").`,
      _heldHalf: held,
    };
  }

  // ── Stuck: find a solver whose work is the same problem, already solved ────
  if (action === 'stuck') {
    const result = await postSolve({ stuck_on: args.stuck_on || '' });
    if (!result.ok) {
      if (result.error === 'no_token' || result.error === 'unauthenticated') {
        return {
          display:
            "⚠️ Couldn't reach the loom — your /vibe session isn't authenticated. Run `vibe init` first.",
        };
      }
      return {
        display: `⚠️ Couldn't search the weave for solvers (${result.error}). Best-effort — try again.`,
      };
    }

    const data = result.data || {};
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    if (!data.stuck_on) {
      return {
        display:
          "No stuck-signal to match on. Pass what the user is fighting as `stuck_on`, " +
          'or attach a strand with a `stuck_on` first (`vibe_weave` with the wall they keep hitting).',
      };
    }
    if (candidates.length === 0) {
      return {
        display:
          `Searched the weave against _"${truncate(data.stuck_on, 120)}"_ — ` +
          `no builder's live work or shipped history looks like the same problem yet. ` +
          `Nothing to surface; don't invent a match.`,
      };
    }

    // Hand the raw recall pool to the model. The model IS Fable here: it decides
    // which candidate (if any) is TRULY the same problem, describes the shape of
    // the fix from their work, and offers a warm intro thread — never fabricates.
    const lines = candidates.slice(0, 8).map((c) => {
      const where = c.online ? 'live now' : 'shipped';
      const matched = Array.isArray(c.matched) && c.matched.length
        ? ` · overlaps: ${c.matched.slice(0, 5).join(', ')}`
        : '';
      return `• @${c.handle} (${where}${matched}): ${truncate(c.text || '', 200)}`;
    });

    return {
      display:
        `🧵 **The user is stuck on:** _"${truncate(data.stuck_on, 160)}"_\n\n` +
        `Candidate solvers from the weave (${candidates.length} found · ${data.live || 0} live):\n` +
        lines.join('\n') +
        `\n\n**Your job (you are Fable at read time):** judge which candidate — if any — is ` +
        `truly the *same problem*, not just shared keywords. Two different error messages can be ` +
        `the same root cause; only you can see that. If one genuinely matches:\n` +
        `  1. Name the shape of what worked for them (from their text above), so the user gets ` +
        `unstuck even without talking.\n` +
        `  2. Offer a warm thread: "@${'{handle}'} hit this and shipped a fix — want me to open a ` +
        `thread so you can ask? (y)". On yes, send with \`vibe_dm @{handle}\` (origin: "stuck_solver") in the user's voice.\n` +
        `If NONE is truly the same problem, say so plainly — never fabricate a match or a fix.`,
      _solvers: candidates,
    };
  }

  // ── Quiet: leave the weave ────────────────────────────────────────────────
  if (action === 'quiet' || args.posture === 'quiet') {
    await postStrand({ digest: {}, posture: 'quiet' });
    return {
      display: '🔕 Left the weave. Your strand is gone — no strand contributed, no moments received. Weave again anytime.',
    };
  }

  // ── Attach (default): spin the strand onto the loom ───────────────────────
  const posture = ['full', 'receive'].includes(args.posture) ? args.posture : 'full';
  const digest = {
    building: args.building || '',
    stuck_on: args.stuck_on || '',
    last_ship: args.last_ship || '',
    voice_sample: args.voice_sample || '',
    tags: Array.isArray(args.tags) ? args.tags : [],
  };

  const result = await postStrand({ digest, posture });
  if (!result.ok) {
    if (result.error === 'no_token' || result.error === 'unauthenticated') {
      return {
        display:
          "⚠️ Couldn't attach your strand — your /vibe session isn't authenticated. Run `vibe init` first, then weave.",
      };
    }
    return {
      display: `⚠️ Couldn't attach your strand (${result.error}). It's best-effort — try again next session.`,
    };
  }

  const live = result.data.live || 0;
  const liveLine =
    live > 0
      ? `${live} other builder${live > 1 ? 's' : ''} live · Fable is watching for moments`
      : "you're the first strand live · Fable will weave you in as others arrive";

  if (posture === 'receive') {
    return {
      display:
        `✓ Woven in **receive-only** — you'll get moments, but your strand stays private.\n` +
        `  (${liveLine})`,
    };
  }
  return {
    display:
      `✓ **strand attached to the weave** — nothing to visit; the magic comes to you.\n` +
      `  (${liveLine})\n\n` +
      `_When a reply lands after you've moved on, Fable will hold your half and offer it back here._`,
  };
}

module.exports = { definition, handler, weaveMoment, findHeldHalf };
