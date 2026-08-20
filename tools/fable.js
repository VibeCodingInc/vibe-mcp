/**
 * vibe fable — a shared, living artifact two builders co-author (Spec 4 of
 * RFC_THE_WEAVE.md). The deepest weave.
 *
 * Two people working toward the same thing — a spec, a design, an API contract,
 * a plan — don't trade messages here. They co-author ONE living object from their
 * separate terminals, and Fable (your in-session model) keeps it coherent: it
 * folds each new contribution into the merged body, flags where two edits
 * genuinely collide, and narrates the delta into the other person's session.
 *
 * The magic is the thing only Fable can do: hold a coherent shared mental model
 * of two people's divergent work and reconcile it *with judgment* ("martin's
 * ordering is safer — no unauthenticated room state"). No shared-doc tool reasons
 * about which design is better. This tool does not merge for you — it hands you
 * the current body + what the other side just added, and asks YOU to weave.
 *
 * Transport lineage: this is the grown-up sibling of vibe_play/vibe_corpse —
 * shared state, but instead of ping-pong turns it's ONE converging artifact, and
 * instead of opaque state the medium (you) actively reconciles it. The durable
 * object lives server-side (/api/weave/fable); a DM ping rides the normal thread
 * so the update lands in the collaborator's terminal — the fable is the point,
 * the chat is the exhaust.
 */

const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle, formatTimeAgo, truncate } = require('./_shared');

const definition = {
  name: 'vibe_fable',
  description:
    'Co-author a living shared artifact with another viber — a spec, design, plan, or contract you both shape from your own terminals, and Fable (you) keeps coherent. ' +
    "This is NOT chat: it's ONE converging object both sides edit, where you merge contributions and flag genuine conflicts with judgment. " +
    "Actions: `open` (start/find a fable — pass `title` and `with:[handle]`); `read` (pull the current body + what the other side added since you last looked — do this before weaving); " +
    "`weave` (fold a contribution in: pass `text` = what the user is adding, `note` = the plain-language delta to narrate to the collaborator, `body` = the FULL updated merged artifact after you reconcile, `conflicts` = [{summary}] where two edits truly collide, `resolve` = [conflictId] a decision closed); `list` (the user's fables). " +
    'YOU are Fable at read time: when you `read` and see the other side changed something that clashes with the current body, reconcile it with judgment, write the merged `body`, and flag the collision as a `conflict` with your reasoning — never silently overwrite their work, never invent agreement that isn\'t there.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'read', 'weave', 'list'],
        description:
          "'open': create or find a fable (needs title + with). 'read': pull current body + the other side's new contributions (do before weaving). 'weave': fold in a contribution / merged body / conflicts. 'list': the user's active fables.",
      },
      id: { type: 'string', description: 'The fable id (from open/list). Required for read and weave.' },
      title: { type: 'string', description: "What you're co-authoring, e.g. 'airc handshake v2'. Required for open." },
      with: {
        type: 'array',
        items: { type: 'string' },
        description: 'Handle(s) of the collaborator(s), e.g. ["@martingrasser"]. Required for open.',
      },
      text: { type: 'string', description: "weave: the raw contribution the user is adding this turn (their intent, in their words)." },
      note: { type: 'string', description: 'weave: a plain-language line narrating this delta to the collaborator — what changed and why. Lands in their terminal.' },
      body: {
        type: 'string',
        description:
          'weave: the FULL updated merged artifact after you reconcile the new contribution into it. This is the coherent shared object — always send the whole thing, not a fragment.',
      },
      conflicts: {
        type: 'array',
        items: { type: 'object' },
        description:
          "weave: collisions you judged between two edits, each {summary: 'you have join→challenge; martin has challenge→join — his is safer'}. Flag, don't silently pick.",
      },
      resolve: {
        type: 'array',
        items: { type: 'string' },
        description: 'weave: ids of conflicts a decision has now closed.',
      },
    },
    required: [],
  },
};

function apiBase() {
  return config.getApiUrl();
}

// All fable state changes go through one authed endpoint; actor is derived
// server-side from the token (never a body handle). We only send the payload.
async function postFable(payload) {
  const token = config.getAuthToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const resp = await fetch(`${apiBase()}/api/weave/fable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: json.error || `http_${resp.status}` };
    return { ok: true, data: json.data || {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Ride the DM thread so a fable update surfaces in the collaborator's terminal.
// The payload tags it so their session recognizes "open the fable, don't reply."
async function pingCollaborators(me, handles, fable, note) {
  const title = fable.title || 'our fable';
  const line = note ? truncate(note, 240) : `updated our fable "${title}"`;
  const body =
    `📖 ${line}\n\n▸ this is our shared fable "${title}" — open it with \`vibe_fable read\` (id: ${fable.id}) ` +
    `to see the merged version and weave your part.`;
  await Promise.all(
    (handles || []).map((h) =>
      store
        .sendMessage(me, normalizeHandle(h), body, 'dm', {
          type: 'fable',
          id: fable.id,
          title,
          version: fable.version,
        })
        .catch(() => {})
    )
  );
}

// Render the reader-facing view of a fable: the merged body, what the other side
// just added (the delta to reconcile), and any open conflicts awaiting a call.
function renderFable(f, { forWeaving } = {}) {
  const withWho = (f.with || []).map((h) => `@${h}`).join(', ') || 'someone';
  let out = `## 📖 ${f.title}\n_with ${withWho} · v${f.version || 0}`;
  if (f.updated_at) out += ` · updated ${formatTimeAgo(f.updated_at)}`;
  out += `_\n\n`;

  out += `**the fable so far:**\n`;
  out += f.body ? `\n${f.body}\n` : `_(empty — nothing woven yet; you write the first version)_\n`;

  const news = Array.isArray(f.new_intents) ? f.new_intents : [];
  if (news.length) {
    out += `\n---\n**${news.length} new from the other side since you last looked — reconcile these:**\n`;
    for (const it of news) {
      const who = it.by ? `@${it.by}` : 'they';
      out += `\n• ${who}: ${truncate(it.text || it.note || '', 400)}`;
    }
  }

  const conflicts = Array.isArray(f.open_conflicts) ? f.open_conflicts : [];
  if (conflicts.length) {
    out += `\n\n---\n**⚠️ open conflicts (a call is needed):**\n`;
    for (const c of conflicts) {
      out += `\n• [${c.id}] ${truncate(c.summary || '', 300)}`;
    }
  }

  return out;
}

async function handler(args = {}) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const me = config.getHandle();
  const action = args.action || (args.id ? 'read' : args.title ? 'open' : 'list');

  const unauth = (err) =>
    err === 'no_token' || err === 'unauthenticated'
      ? { display: "⚠️ Couldn't reach the weave — your /vibe session isn't authenticated. Run `vibe init` first." }
      : null;

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const result = await postFable({ action: 'list' });
    if (!result.ok) return unauth(result.error) || { display: `⚠️ Couldn't list fables (${result.error}).` };
    const fables = result.data.fables || [];
    if (!fables.length) {
      return {
        display:
          "No shared fables yet. Start one with someone you're building alongside:\n" +
          '`vibe_fable open --title "airc handshake v2" --with @martingrasser`\n\n' +
          'A fable is one living artifact you both shape — Fable keeps it coherent across your two terminals.',
      };
    }
    const lines = fables.map((f) => {
      const withWho = (f.with || []).map((h) => `@${h}`).join(', ');
      return `• **${f.title}** _(with ${withWho}${f.updated_at ? ` · ${formatTimeAgo(f.updated_at)}` : ''})_ — id: ${f.id}`;
    });
    return {
      display:
        `## 📖 your fables\n\n${lines.join('\n')}\n\n` +
        `Open one with \`vibe_fable read\` (pass its id) to see the merged artifact and weave.`,
    };
  }

  // ── open ──────────────────────────────────────────────────────────────────
  if (action === 'open') {
    const title = (args.title || '').trim();
    const withList = Array.isArray(args.with) ? args.with : args.with ? [args.with] : [];
    if (!title) return { display: 'Give the fable a title — what are you co-authoring? `vibe_fable open --title "…" --with @handle`' };
    if (!withList.length) return { display: 'Who are you co-authoring with? `vibe_fable open --title "…" --with @handle`' };

    const result = await postFable({ action: 'open', title, with: withList });
    if (!result.ok) {
      if (unauth(result.error)) return unauth(result.error);
      if (result.error === 'need_a_collaborator') {
        return { display: `Couldn't open the fable — @${normalizeHandle(withList[0])} isn't a being you can co-author with. Invite a viber or an agent on /vibe.` };
      }
      return { display: `⚠️ Couldn't open the fable (${result.error}).` };
    }
    const f = result.data.fable;
    // Let the collaborator know a shared space now exists in their terminal.
    await pingCollaborators(me, f.with, f, `opened a shared fable: "${f.title}"`);
    return {
      display:
        renderFable(f) +
        `\n\n---\n**You're in a fable now.** This is one shared artifact, not a chat. ` +
        `Write the opening version of "${f.title}" as the \`body\`, add a \`note\` for ${(f.with || []).map((h) => `@${h}`).join(', ')}, ` +
        `and \`weave\` it in. As they contribute, \`read\` to see their edits and reconcile them into the body — flagging any real conflict with your judgment.`,
      _fable: f,
    };
  }

  // ── read ──────────────────────────────────────────────────────────────────
  if (action === 'read') {
    if (!args.id) return { display: 'Which fable? Pass its `id` (see `vibe_fable list`).' };
    const result = await postFable({ action: 'read', id: args.id });
    if (!result.ok) {
      if (unauth(result.error)) return unauth(result.error);
      if (result.error === 'not_found') return { display: "That fable doesn't exist (or expired). `vibe_fable list` to see your active ones." };
      if (result.error === 'not_a_participant') return { display: "That fable isn't one you're part of." };
      return { display: `⚠️ Couldn't read the fable (${result.error}).` };
    }
    const f = result.data.fable;
    const news = Array.isArray(f.new_intents) ? f.new_intents : [];
    const conflicts = Array.isArray(f.open_conflicts) ? f.open_conflicts : [];

    let coach = '';
    if (news.length || conflicts.length) {
      coach =
        `\n\n---\n**You are Fable here.** ` +
        (news.length
          ? `Reconcile the ${news.length} new contribution${news.length > 1 ? 's' : ''} into the body: where it fits, fold it in; where it genuinely clashes with what's there, flag a \`conflict\` with your judgment on which is better and why — don't silently overwrite. `
          : '') +
        (conflicts.length ? `Resolve the open conflict${conflicts.length > 1 ? 's' : ''} if a call is now clear (\`resolve:[id]\`). ` : '') +
        `Then write the FULL merged \`body\` and \`weave\` it back with a \`note\` narrating what changed. Never invent agreement that isn't there.`;
    } else {
      coach = `\n\n---\nNothing new from the other side since you last looked. Add to it anytime: \`weave\` a new \`body\` + \`note\`.`;
    }
    return { display: renderFable(f, { forWeaving: true }) + coach, _fable: f };
  }

  // ── weave ─────────────────────────────────────────────────────────────────
  if (action === 'weave') {
    if (!args.id) return { display: 'Which fable? Pass its `id` (see `vibe_fable list`).' };
    const payload = {
      action: 'weave',
      id: args.id,
      text: args.text || '',
      note: args.note || '',
    };
    if (typeof args.body === 'string') payload.body = args.body;
    if (Array.isArray(args.conflicts)) payload.conflicts = args.conflicts;
    if (Array.isArray(args.resolve)) payload.resolve = args.resolve;

    const result = await postFable(payload);
    if (!result.ok) {
      if (unauth(result.error)) return unauth(result.error);
      if (result.error === 'not_found') return { display: "That fable doesn't exist (or expired)." };
      if (result.error === 'not_a_participant') return { display: "That fable isn't one you're part of." };
      if (result.error === 'nothing_to_weave') return { display: 'Nothing to weave — pass a `body`, `note`, `text`, `conflicts`, or `resolve`.' };
      return { display: `⚠️ Couldn't weave (${result.error}).` };
    }
    const f = result.data.fable;
    const notify = result.data.notify || f.with || [];
    // Narrate the delta into the collaborator's terminal via the DM thread.
    await pingCollaborators(me, notify, f, args.note || `wove into "${f.title}"`);

    let tail = `\n\n---\n✓ Woven (v${f.version}) and narrated to ${(notify || []).map((h) => `@${h}`).join(', ') || 'your collaborator'}.`;
    const openC = Array.isArray(f.open_conflicts) ? f.open_conflicts.length : 0;
    if (openC) tail += ` ${openC} conflict${openC > 1 ? 's' : ''} still open — surface ${openC > 1 ? 'them' : 'it'} to the user for a call.`;
    return { display: renderFable(f) + tail, _fable: f };
  }

  return { display: 'Unknown fable action. Use open / read / weave / list.' };
}

module.exports = { definition, handler };
