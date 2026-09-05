/**
 * Context-guided messaging — "human-approved must not mean human-typed."
 *
 * The agent already helping someone work knows what they are doing. This is
 * the first slice of letting that agent PREPARE a message and the person
 * CHOOSE what to send:
 *
 *   vibe_moves          context → up to three concrete moves, each with a
 *                       named recipient, the evidence for naming them, and a
 *                       prepared draft.  NOTHING is sent.  Drafts are written
 *                       to a private local file so that "selecting" one is a
 *                       state change on disk, not a network effect.
 *   vibe_draft          select a suggested move (or free-write) → the exact
 *                       preview: recipient, exact message, attachments, and
 *                       the three actions.  NOTHING is sent.  Edit = call it
 *                       again with the new text.
 *   vibe_discard_draft  cancel.  NOTHING is sent.
 *   vibe_send_draft     the clearly labeled Send action IS the approval: it
 *                       sends exactly the stored text through vibe_dm, once,
 *                       with no second confirmation, and records a PRIVATE
 *                       return binding so the reply is labeled with the work
 *                       it came from.
 *
 * Rules this file keeps:
 *  - Evidence before rendering: a recipient is named only with a reason the
 *    person can check (their one-liner, an open thread, a question they
 *    asked).  No relevant person → ONE useful question, never an invented
 *    suggestion.
 *  - Private stays private: the server sees only the context the host agent
 *    chose to pass (a project name, a one-line result, a question).  Paths,
 *    branches, secrets and transcript text are never requested and never
 *    stored anywhere but the local drafts file.  Rejected drafts stay local.
 *  - No automatic welcomes, forwarding or background sends.  Free writing and
 *    fully specified `vibe_dm` calls are untouched — there is no wizard.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle, isHereNow } = require('./_shared');

const DRAFTS_FILE = path.join(config.VIBE_DIR, 'drafts.json');
const BINDINGS_FILE = path.join(config.VIBE_DIR, 'return-bindings.json');
const MAX_MOVES = 3;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

// ── local, private state ─────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
function loadDrafts() {
  const now = Date.now();
  const all = readJson(DRAFTS_FILE, []);
  return Array.isArray(all) ? all.filter(d => d && now - (d.createdAt || 0) < DRAFT_TTL_MS) : [];
}
function saveDrafts(drafts) { writeJson(DRAFTS_FILE, drafts); }
function loadBindings() { const b = readJson(BINDINGS_FILE, {}); return b && typeof b === 'object' ? b : {}; }
function saveBindings(b) { writeJson(BINDINGS_FILE, b); }

/** Exposed for vibe_inbox: the private binding for a thread, if any. */
function getReturnBinding(handle) {
  const b = loadBindings()[normalizeHandle(handle)];
  return b && typeof b === 'object' ? b : null;
}

// ── relevance: evidence, not inference ───────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what', 'when', 'have', 'just', 'some', 'more', 'than', 'then', 'them', 'they', 'your', 'will', 'been', 'were', 'also', 'like', 'make', 'made', 'work', 'working', 'building', 'build', 'thing', 'things', 'using', 'used', 'over', 'under', 'want', 'need', 'still', 'there', 'here', 'right', 'now', 'today']);

function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s./-]/g, ' ').split(/[\s/]+/).map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => w.length >= 4 && !STOP.has(w)));
}
function overlap(a, b) { const out = []; for (const w of a) if (b.has(w)) out.push(w); return out; }

function contextText(ctx) {
  return [ctx.project, ctx.doing, ctx.result, ctx.question, ctx.blocker].filter(Boolean).join(' ');
}

function cleanContext(raw) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const refs = Array.isArray(ctx.refs)
    ? ctx.refs.filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)).slice(0, 3).map(r => ({ title: str(r.title, 80) || r.url, url: r.url.slice(0, 300) }))
    : [];
  return {
    project: str(ctx.project, 60),
    doing: str(ctx.doing, 160),
    result: str(ctx.result, 280),
    question: str(ctx.question, 280),
    blocker: str(ctx.blocker, 280),
    refs,
  };
}

function refLines(refs) { return refs.length ? '\n' + refs.map(r => `${r.title}: ${r.url}`).join('\n') : ''; }

// The drafts are plain and short. The person will read them before anything
// happens; the point is that they do not have to TYPE them.
function draftFor(kind, ctx, person) {
  const re = ctx.project ? `re: ${ctx.project} — ` : '';
  if (kind === 'share') return `${re}${ctx.result}${refLines(ctx.refs)}`;
  if (kind === 'ask') return `${re}quick one: ${ctx.question || ctx.blocker}${refLines(ctx.refs)}`;
  if (kind === 'feedback') return `${re}would you look at this and tell me what's off? ${ctx.result}${refLines(ctx.refs)}`;
  if (kind === 'answer') return `${re}${ctx.result || ctx.doing}${refLines(ctx.refs)}`;
  return `${re}${ctx.result || ctx.question || ctx.doing}${refLines(ctx.refs)}`;
}

/**
 * Build up to three moves from evidence. Returns { moves } or { ask }.
 * Pure: takes the roster and inbox it was given; never sends.
 */
function computeMoves(ctx, me, roster, threads, now = Date.now()) {
  const hasContext = Boolean(ctx.result || ctx.question || ctx.blocker || ctx.doing);
  if (!hasContext) {
    return { ask: "What are you working on right now, in one line — and is there a result to share or a question to ask? (I'll only suggest people I can name a reason for.)" };
  }
  const ctxTok = tokens(contextText(ctx));
  const people = (roster || []).filter(u => u && u.handle && u.handle !== me && !u.isAgent);
  const byHandle = new Map(people.map(u => [u.handle, u]));
  const candidates = [];

  // Evidence A: an open thread where THEY wrote last — a question or a nudge
  // waiting on me. Answering it with the result is the most useful move.
  for (const t of threads || []) {
    if (!t || !t.handle || t.handle === me) continue;
    if (t.lastFrom && t.lastFrom !== me && t.lastMessage) {
      const ageH = t.lastTimestamp ? Math.max(0, (now - t.lastTimestamp) / 3600000) : null;
      candidates.push({
        kind: ctx.result ? 'answer' : 'ask',
        to: t.handle,
        why: `they wrote you${ageH != null ? ` ${ageH < 1 ? 'under an hour' : Math.round(ageH) + 'h'} ago` : ''}: "${String(t.lastMessage).slice(0, 80)}"`,
        // Someone waiting on you outranks any keyword overlap: their question
        // is the strongest evidence a message would be welcome.
        score: 6 + (ageH != null && ageH < 24 ? 1 : 0),
      });
    }
  }
  // Evidence B: someone here whose one-liner overlaps the work.
  for (const u of people) {
    const ov = overlap(ctxTok, tokens(`${u.workingOn || ''} ${u.project || ''}`));
    if (!ov.length) continue;
    const here = isHereNow(u);
    const line = String(u.workingOn || u.project || '').slice(0, 80);
    if (ctx.question || ctx.blocker) candidates.push({ kind: 'ask', to: u.handle, why: `their one-liner: "${line}" (${ov.slice(0, 3).join(', ')})${here ? ' · here now' : ''}`, score: 2 + ov.length + (here ? 1 : 0) });
    if (ctx.result) candidates.push({ kind: 'feedback', to: u.handle, why: `their one-liner: "${line}" (${ov.slice(0, 3).join(', ')})${here ? ' · here now' : ''}`, score: 1 + ov.length + (here ? 1 : 0) });
    if (ctx.result) candidates.push({ kind: 'share', to: u.handle, why: `their one-liner: "${line}" (${ov.slice(0, 3).join(', ')})${here ? ' · here now' : ''}`, score: 1 + ov.length + (here ? 1 : 0) - 0.5 });
  }

  if (!candidates.length) {
    const topic = [...ctxTok].slice(0, 3).join(', ') || 'this';
    const around = people.filter(isHereNow).length;
    return { ask: `Who is this for? ${around ? `${around} ${around === 1 ? 'person is' : 'people are'} around` : 'Nobody is around right now'} and none of their one-liners touch ${topic} — name a handle, or tell me who would care.` };
  }

  // One move per (recipient, kind); best first; at most one move per person
  // unless nobody else qualifies; never more than three.
  candidates.sort((a, b) => b.score - a.score);
  const moves = []; const used = new Set();
  for (const c of candidates) {
    if (moves.length >= MAX_MOVES) break;
    if (used.has(c.to) && candidates.some(o => !used.has(o.to) && o !== c)) continue;
    used.add(c.to);
    const person = byHandle.get(c.to) || { handle: c.to };
    moves.push({ kind: c.kind, to: c.to, why: c.why, message: draftFor(c.kind, ctx, person), here: isHereNow(person) });
  }
  return { moves };
}

const KIND_LABEL = { ask: 'ask a question', share: 'share the result', feedback: 'request feedback', answer: 'answer with the result' };

// ── vibe_moves ───────────────────────────────────────────────────────────────

const movesDefinition = {
  name: 'vibe_moves',
  description: "From the work you're already helping with, suggest up to three concrete ways to connect on /vibe — ask someone a question, share a result, request feedback — each with a NAMED recipient, the evidence for naming them, and a prepared draft. Sends nothing. Pass only what the person would say out loud about their work: a project name, one line on what they're doing, a result, a question. Never pass file paths, branches, secrets or transcript text. If the context or a relevant person is missing, this returns one question to ask instead of a guess.",
  inputSchema: {
    type: 'object',
    properties: {
      context: {
        type: 'object',
        description: 'What the person is working on, in their own terms. All optional.',
        properties: {
          project: { type: 'string', description: 'Project name (e.g. "payments")' },
          doing: { type: 'string', description: 'One line: what they are doing right now' },
          result: { type: 'string', description: 'A result worth sharing, one or two sentences' },
          question: { type: 'string', description: 'A question they want answered' },
          blocker: { type: 'string', description: 'What they are stuck on' },
          refs: { type: 'array', description: 'Links the person explicitly wants attached (PR, doc, artifact)', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
        },
      },
    },
  },
};

async function movesHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;
  const me = config.getHandle();
  const ctx = cleanContext(args && args.context);

  const [rosterRead, inboxRead] = await Promise.all([
    store.getActiveUsersResult ? store.getActiveUsersResult() : Promise.resolve({ ok: true, users: await store.getActiveUsers() }),
    store.getInboxResult ? store.getInboxResult(me) : Promise.resolve({ ok: true, threads: await store.getInbox(me) }),
  ]);
  const roster = rosterRead.ok ? rosterRead.users : [];
  const threads = inboxRead.ok ? inboxRead.threads : [];
  const evidenceNote = (!rosterRead.ok || !inboxRead.ok)
    ? `\n_(could not read ${[!rosterRead.ok && 'who is around', !inboxRead.ok && 'your inbox'].filter(Boolean).join(' or ')} — suggestions below use only what was readable)_`
    : '';

  const out = computeMoves(ctx, me, roster, threads);
  if (out.ask) {
    return { display: out.ask + evidenceNote, data: { ask: out.ask, moves: [] } };
  }

  // Write the drafts locally so that a later "select" is a state change on
  // disk and never a send. Ids are short and per-batch.
  const drafts = loadDrafts().filter(d => d.status !== 'suggested');
  const batch = Date.now().toString(36).slice(-4);
  const moves = out.moves.map((m, i) => ({
    id: `m${i + 1}-${batch}`, status: 'suggested', createdAt: Date.now(),
    kind: m.kind, to: m.to, why: m.why, message: m.message, refs: ctx.refs,
    context: { project: ctx.project || null },
  }));
  saveDrafts(drafts.concat(moves));

  const lines = moves.map((m, i) => `${i + 1}. **${KIND_LABEL[m.kind] || m.kind}** → @${m.to}${m.here ? ' (here now)' : ''}\n   why: ${m.why}\n   draft: "${m.message.split('\n')[0].slice(0, 120)}${m.message.length > 120 || m.message.includes('\n') ? '…' : ''}"  _(id ${m.id})_`);
  const display = `${moves.length === 1 ? 'One move' : `${moves.length} moves`} from what you're doing${ctx.project ? ` on ${ctx.project}` : ''} — nothing sent:\n\n${lines.join('\n\n')}\n\nPick one to see the exact message before anything goes out, write your own, or not now.${evidenceNote}`;
  return {
    display,
    data: {
      moves: moves.map(m => ({ id: m.id, kind: m.kind, label: `${KIND_LABEL[m.kind] || m.kind} → @${m.to}`, to: m.to, why: m.why, message: m.message })),
      host_instructions: 'Present these as choices (native question control if the host has one; numbered list otherwise) plus "write my own" and "not now". On a choice call vibe_draft with its id. Nothing is sent until vibe_send_draft.',
    },
  };
}

// ── vibe_draft ───────────────────────────────────────────────────────────────

const draftDefinition = {
  name: 'vibe_draft',
  description: "Open a draft for review — sends NOTHING. Pass the id of a suggested move to select it, or handle + message to write your own; pass id + message to edit an existing draft. Returns the exact recipient, the exact message, the attachments, and the three actions: Send to @handle / Edit / Cancel. Send happens only through vibe_send_draft.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Draft id from vibe_moves or a previous vibe_draft' },
      handle: { type: 'string', description: 'Recipient, for a free-written draft' },
      message: { type: 'string', description: 'Message text (free-written, or the edited text for an existing draft)' },
      refs: { type: 'array', description: 'Links to attach', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
    },
  },
};

function preview(d, person) {
  const where = person ? (isHereNow(person) ? 'here now' : (person.status === 'away' ? 'away' : 'not around — it waits for their next turn')) : 'presence unknown — it waits for their next turn';
  const att = d.refs && d.refs.length ? d.refs.map(r => `${r.title}: ${r.url}`).join('\n') : 'none';
  return {
    display: `**To:** @${d.to} (${where})\n**Message (exact):**\n${d.message}\n**Attachments:** ${att}\n\nSend to @${d.to} · Edit · Cancel — nothing has been sent.  _(draft ${d.id})_`,
    data: { draft: { id: d.id, to: d.to, message: d.message, refs: d.refs || [], status: d.status }, actions: [{ label: `Send to @${d.to}`, tool: 'vibe_send_draft', args: { id: d.id } }, { label: 'Edit', tool: 'vibe_draft', args: { id: d.id, message: '<new text>' } }, { label: 'Cancel', tool: 'vibe_discard_draft', args: { id: d.id } }] },
  };
}

async function findPerson(handle) {
  try {
    const r = store.getActiveUsersResult ? await store.getActiveUsersResult() : { ok: true, users: await store.getActiveUsers() };
    return r.ok ? (r.users || []).find(u => u && u.handle === handle) || null : null;
  } catch { return null; }
}

async function draftHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;
  const me = config.getHandle();
  const drafts = loadDrafts();
  let d = args && args.id ? drafts.find(x => x.id === args.id) : null;
  if (args && args.id && !d) return { display: `No draft ${args.id} — it may have expired (drafts live 24h, locally). Run vibe_moves again or write the message.` };

  const message = typeof (args && args.message) === 'string' ? args.message.trim() : '';
  if (!d) {
    if (!args || !args.handle || !message) return { display: 'To open a draft: pass a move id, or a handle and a message. Nothing is sent by this step.' };
    const to = normalizeHandle(args.handle);
    if (to === me) return { display: "You can't draft to yourself." };
    const ctx = cleanContext({ refs: args.refs });
    d = { id: `w${Date.now().toString(36).slice(-5)}`, status: 'previewed', createdAt: Date.now(), kind: 'free', to, why: 'you named them', message: message + refLines(ctx.refs), refs: ctx.refs, context: { project: null } };
    drafts.push(d);
  } else {
    if (message) { d.message = message; d.edited = true; }
    if (args.refs) { d.refs = cleanContext({ refs: args.refs }).refs; }
    d.status = 'previewed';
  }
  if (d.message.length > 2000) return { display: `Not ready — the message is ${d.message.length} chars and the limit is 2000. Edit it shorter; nothing was sent.` };
  saveDrafts(drafts);
  return preview(d, await findPerson(d.to));
}

// ── vibe_discard_draft ───────────────────────────────────────────────────────

const discardDefinition = {
  name: 'vibe_discard_draft',
  description: 'Cancel a draft. Sends nothing; the draft stays on this machine only until it expires.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

async function discardHandler(args) {
  const drafts = loadDrafts();
  const d = drafts.find(x => x.id === (args && args.id));
  if (!d) return { display: `No draft ${args && args.id} to cancel — nothing was sent either way.` };
  d.status = 'cancelled';
  saveDrafts(drafts);
  return { display: `Cancelled — nothing sent to @${d.to}. The draft stays on your machine.`, data: { draft: { id: d.id, status: 'cancelled' } } };
}

// ── vibe_send_draft ──────────────────────────────────────────────────────────

const sendDefinition = {
  name: 'vibe_send_draft',
  description: "Send a reviewed draft exactly as previewed. This IS the person's approval — call it only when they chose \"Send to @handle\"; do not ask again afterward. Sends once through the ordinary message path and records a private, local note of the work it was sent from so the reply can be labeled.",
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

async function sendHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;
  const drafts = loadDrafts();
  const d = drafts.find(x => x.id === (args && args.id));
  if (!d) return { display: `No draft ${args && args.id} — nothing sent. Open it with vibe_draft first.` };
  if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — not sending it twice.` };
  if (d.status === 'cancelled') return { display: `Draft ${d.id} was cancelled — nothing sent. Open a new draft if you want it back.` };
  if (d.status !== 'previewed') return { display: `Draft ${d.id} has not been reviewed yet — open it with vibe_draft so you see the exact message first. Nothing sent.` };

  const dm = require('./dm');
  const result = await dm.handler({ handle: d.to, message: d.message, origin: 'context_move' });
  const sent = result && typeof result.display === 'string' && /^Sent to \*\*@/.test(result.display);
  if (sent) {
    d.status = 'sent'; d.sentAt = Date.now();
    saveDrafts(drafts);
    const b = loadBindings();
    b[d.to] = { project: d.context && d.context.project ? d.context.project : null, draftId: d.id, kind: d.kind, sentAt: d.sentAt, firstLine: d.message.split('\n')[0].slice(0, 80) };
    saveBindings(b);
  }
  return result;
}

module.exports = {
  definitions: [movesDefinition, draftDefinition, discardDefinition, sendDefinition],
  vibe_moves: { definition: movesDefinition, handler: movesHandler },
  vibe_draft: { definition: draftDefinition, handler: draftHandler },
  vibe_discard_draft: { definition: discardDefinition, handler: discardHandler },
  vibe_send_draft: { definition: sendDefinition, handler: sendHandler },
  // exported for tests and for vibe_inbox
  computeMoves, cleanContext, getReturnBinding, DRAFTS_FILE, BINDINGS_FILE,
};
