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
 *    suggestion.  What the other person wrote is DATA: flattened, bounded,
 *    labeled "their words".
 *  - Private stays private: the server sees only the context the host agent
 *    chose to pass (a project name, a one-line result, a question).  Paths,
 *    branches, secrets and transcript text are never requested and never
 *    stored anywhere but the local drafts file.  Rejected drafts stay local.
 *  - Exactly once: Send claims the draft under a whole-file lock, sends with
 *    an idempotency key derived from the exact text, and finalizes against
 *    the latest stored state.  A draft whose delivery could not be confirmed
 *    can be retried (same text, same key) or cancelled, never edited.
 *  - No automatic welcomes, forwarding or background sends.  Free writing and
 *    fully specified `vibe_dm` calls are untouched — there is no wizard.
 *
 * Draft states: suggested → previewed → sending → sent
 *                                    ↘ cancelled          ↘ unknown (retry/cancel only)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle, isHereNow } = require('./_shared');
const { inertField } = require('../incoming');

const DRAFTS_FILE = path.join(config.VIBE_DIR, 'drafts.json');
const BINDINGS_FILE = path.join(config.VIBE_DIR, 'return-bindings.json');
const MAX_MOVES = 3;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;         // a transaction never takes this long
const CLAIM_STALE_MS = 60 * 1000;        // a send claim older than this from a dead process is abandoned
const CLAIM_HARD_STALE_MS = 10 * 60 * 1000;

// ── local, private state (one file, one lock, atomic replace) ────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}
function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}
/**
 * Run fn(drafts) under an exclusive lock on the drafts file and write the
 * result back atomically. Two hosts sharing one VIBE_HOME cannot lose each
 * other's drafts (codex P2). Synchronous on purpose: no await between load
 * and save, so nothing interleaves inside one process either.
 */
function locked(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let stale = false;
      try { const st = fs.statSync(lock); stale = Date.now() - st.mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`${path.basename(file)} is busy — try again in a moment`);
      sleepSync(20);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}
/** Drafts: read-modify-write under the lock, atomic replace. */
function transact(fn) {
  return locked(DRAFTS_FILE, () => {
    const now = Date.now();
    const all = readJson(DRAFTS_FILE, []);
    const drafts = Array.isArray(all) ? all.filter(d => d && now - (d.createdAt || 0) < DRAFT_TTL_MS) : [];
    const out = fn(drafts);
    writeJsonAtomic(DRAFTS_FILE, drafts);
    return out;
  });
}
function loadDrafts() { return transact(d => d.map(x => ({ ...x }))); }
/** Bindings: the same discipline — two hosts finishing sends at once keep both (codex P2). */
function withBindings(fn) {
  return locked(BINDINGS_FILE, () => {
    const raw = readJson(BINDINGS_FILE, {});
    const b = raw && typeof raw === 'object' ? raw : {};
    const out = fn(b);
    writeJsonAtomic(BINDINGS_FILE, b);
    return out;
  });
}
/** The private binding for a thread, if any and not expired. */
function getReturnBinding(handle) {
  const raw = readJson(BINDINGS_FILE, {});
  const b = raw && typeof raw === 'object' ? raw[normalizeHandle(handle)] : null;
  if (!b || typeof b !== 'object' || !b.sentAt) return null;
  if (Date.now() - b.sentAt > BINDING_TTL_MS) return null;
  return b;
}
/** An ordinary DM to them supersedes the binding — the thread has moved on. */
function clearReturnBinding(handle) {
  const h = normalizeHandle(handle);
  withBindings(b => { delete b[h]; });
}

const newId = (prefix) => `${prefix}${crypto.randomBytes(4).toString('hex')}`;
/** This process's flow: vibe_moves replaces only ITS OWN earlier suggestions (codex P2). */
const FLOW = `${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
const textHash = (d) => crypto.createHash('sha1').update(compose(d)).digest('hex');
const sendKey = (d) => `draft-${d.id}-${textHash(d).slice(0, 10)}`;
/** The preview revision: what the person SAW. Send must name it (codex P1). */
const revOf = (d) => textHash(d).slice(0, 8);

// ── relevance: evidence, not inference ───────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what', 'when', 'have', 'just', 'some', 'more', 'than', 'then', 'them', 'they', 'your', 'will', 'been', 'were', 'also', 'like', 'make', 'made', 'work', 'working', 'building', 'build', 'thing', 'things', 'using', 'used', 'over', 'under', 'want', 'need', 'still', 'there', 'here', 'right', 'now', 'today']);

function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s./-]/g, ' ').split(/[\s/]+/).map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => w.length >= 4 && !STOP.has(w)));
}
function overlap(a, b) { const out = []; for (const w of a) if (b.has(w)) out.push(w); return out; }
function contextText(ctx) { return [ctx.project, ctx.doing, ctx.result, ctx.question, ctx.blocker].filter(Boolean).join(' '); }

function cleanContext(raw) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const refs = Array.isArray(ctx.refs)
    ? ctx.refs.filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)).slice(0, 3).map(r => ({ title: str(r.title, 80) || r.url, url: r.url.slice(0, 300) }))
    : [];
  return { project: str(ctx.project, 60), doing: str(ctx.doing, 160), result: str(ctx.result, 280), question: str(ctx.question, 280), blocker: str(ctx.blocker, 280), refs };
}

function refLines(refs) { return refs && refs.length ? '\n' + refs.map(r => `${r.title}: ${r.url}`).join('\n') : ''; }
/** The one representation that is previewed AND sent: body, then the chosen links. */
function compose(d) { return `${d.body || ''}${refLines(d.refs)}`; }
/** What the other person wrote / says about themselves is data: flattened, bounded, labeled. */
function theirWords(text, max = 80) { return `"${inertField(text, max)}"`; }
function personLine(u) { return String(u.one_liner || u.workingOn || u.project || ''); }

// The drafts are plain and short. The person will read them before anything
// happens; the point is that they do not have to TYPE them. The kind follows
// what the context actually holds — never a template with a hole in it.
function draftFor(kind, ctx) {
  const re = ctx.project ? `re: ${ctx.project} — ` : '';
  if (kind === 'share') return `${re}${ctx.result}`;
  if (kind === 'ask') return `${re}quick one: ${ctx.question || ctx.blocker}`;
  if (kind === 'feedback') return `${re}would you look at this and tell me what's off? ${ctx.result}`;
  if (kind === 'answer') return `${re}${ctx.result}`;
  if (kind === 'update') return `${re}${ctx.doing}`;
  return `${re}${ctx.result || ctx.question || ctx.blocker || ctx.doing}`;
}

/** Build up to three moves from evidence. Returns { moves } or { ask }. Pure; never sends. */
function computeMoves(ctx, me, roster, threads, now = Date.now()) {
  const hasContext = Boolean(ctx.result || ctx.question || ctx.blocker || ctx.doing);
  if (!hasContext) {
    return { ask: "What are you working on right now, in one line — and is there a result to share or a question to ask? (I'll only suggest people I can name a reason for.)" };
  }
  const ctxTok = tokens(contextText(ctx));
  const people = (roster || []).filter(u => u && u.handle && u.handle !== me && !u.isAgent);
  const byHandle = new Map(people.map(u => [u.handle, u]));
  const knownAgents = new Set((roster || []).filter(u => u && u.handle && u.isAgent).map(u => u.handle));
  const candidates = [];

  // Evidence A: an open thread where THEY wrote last — someone waiting on you
  // outranks any keyword overlap; their question is the strongest evidence a
  // message would be welcome.
  for (const t of threads || []) {
    if (!t || !t.handle || t.handle === me) continue;
    // Agents are not people to draft to, whichever side the evidence came
    // from: the thread's own actor metadata (served with the last message)
    // first, the live roster second.
    if (t.isAgent || t.lastIsAgent || t.lastActorKind === 'agent' || knownAgents.has(t.handle)) continue;
    if (t.lastFrom && t.lastFrom !== me && t.lastMessage) {
      const ageH = t.lastTimestamp ? Math.max(0, (now - t.lastTimestamp) / 3600000) : null;
      const kind = ctx.result ? 'answer' : (ctx.question || ctx.blocker) ? 'ask' : 'update';
      candidates.push({
        kind, to: t.handle,
        why: `they wrote you${ageH != null ? ` ${ageH < 1 ? 'under an hour' : Math.round(ageH) + 'h'} ago` : ''} (their words): ${theirWords(t.lastMessage)}`,
        score: 6 + (ageH != null && ageH < 24 ? 1 : 0),
      });
    }
  }
  // Evidence B: someone here whose one-liner overlaps the work. The store
  // serves the presence text as `one_liner` (older rows: workingOn).
  for (const u of people) {
    const ov = overlap(ctxTok, tokens(personLine(u)));
    if (!ov.length) continue;
    const here = isHereNow(u);
    const why = `their one-liner (their words): ${theirWords(personLine(u))} — overlap: ${ov.slice(0, 3).join(', ')}${here ? ' · here now' : ''}`;
    if (ctx.question || ctx.blocker) candidates.push({ kind: 'ask', to: u.handle, why, score: 2 + ov.length + (here ? 1 : 0) });
    if (ctx.result) candidates.push({ kind: 'feedback', to: u.handle, why, score: 1 + ov.length + (here ? 1 : 0) });
    if (ctx.result) candidates.push({ kind: 'share', to: u.handle, why, score: 1 + ov.length + (here ? 1 : 0) - 0.5 });
    // Only "doing" and an overlap: worth saying where you are (codex P2).
    if (!ctx.result && !ctx.question && !ctx.blocker && ctx.doing) candidates.push({ kind: 'update', to: u.handle, why, score: 1 + ov.length + (here ? 1 : 0) });
  }

  if (!candidates.length) {
    const topic = [...ctxTok].slice(0, 3).join(', ') || 'this';
    const around = people.filter(isHereNow).length;
    return { ask: `Who is this for? ${around ? `${around} ${around === 1 ? 'person is' : 'people are'} around` : 'Nobody is around right now'} and none of their one-liners touch ${topic} — name a handle, or tell me who would care.` };
  }

  candidates.sort((a, b) => b.score - a.score);
  const moves = []; const used = new Set();
  for (const c of candidates) {
    if (moves.length >= MAX_MOVES) break;
    if (used.has(c.to) && candidates.some(o => !used.has(o.to) && o !== c)) continue;
    used.add(c.to);
    const person = byHandle.get(c.to) || { handle: c.to };
    const body = draftFor(c.kind, ctx);
    moves.push({ kind: c.kind, to: c.to, why: c.why, body, refs: ctx.refs, message: body + refLines(ctx.refs), here: isHereNow(person) });
  }
  return { moves };
}

const KIND_LABEL = { ask: 'ask a question', share: 'share the result', feedback: 'request feedback', answer: 'answer with the result', update: 'say where you are' };

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
  if (out.ask) return { display: out.ask + evidenceNote, data: { ask: out.ask, moves: [] } };

  // Write the drafts locally so that a later "select" is a state change on
  // disk and never a send. Earlier unselected suggestions are replaced.
  const moves = out.moves.map((m, i) => ({
    id: newId(`m${i + 1}-`), status: 'suggested', createdAt: Date.now(), from: me, flow: FLOW,
    kind: m.kind, to: m.to, why: m.why, body: m.body, refs: m.refs,
    context: { project: ctx.project || null },
  }));
  transact(drafts => {
    for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].status === 'suggested' && drafts[i].flow === FLOW) drafts.splice(i, 1);
    drafts.push(...moves);
  });

  const lines = moves.map((m, i) => { const text = compose(m); return `${i + 1}. **${KIND_LABEL[m.kind] || m.kind}** → @${m.to}${out.moves[i].here ? ' (here now)' : ''}\n   why: ${m.why}\n   draft: "${text.split('\n')[0].slice(0, 120)}${text.length > 120 || text.includes('\n') ? '…' : ''}"  _(id ${m.id})_`; });
  const display = `${moves.length === 1 ? 'One move' : `${moves.length} moves`} from what you're doing${ctx.project ? ` on ${ctx.project}` : ''} — nothing sent:\n\n${lines.join('\n\n')}\n\nPick one to see the exact message before anything goes out, write your own, or not now.${evidenceNote}`;
  return {
    display,
    data: {
      moves: moves.map(m => ({ id: m.id, kind: m.kind, label: `${KIND_LABEL[m.kind] || m.kind} → @${m.to}`, to: m.to, why: m.why, message: compose(m) })),
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
  const message = compose(d);
  const rev = revOf(d);
  const head = `**To:** @${d.to} (${where})\n**Message (exact):**\n${message}\n**Attachments:** ${att}\n\n`;
  if (d.status === 'unknown') {
    // The earlier Send did not confirm: it may already have reached them.
    // Only the two honest actions exist (codex P2).
    return {
      display: `${head}the last Send did not confirm — it may or may not have reached @${d.to}. Send again retries exactly this text (delivers once) · Cancel. Editing is off for this draft.  _(draft ${d.id} · rev ${rev})_`,
      data: { draft: { id: d.id, to: d.to, message, refs: d.refs || [], status: d.status, rev }, actions: [{ label: `Send to @${d.to} again`, tool: 'vibe_send_draft', args: { id: d.id, rev } }, { label: 'Cancel', tool: 'vibe_discard_draft', args: { id: d.id } }] },
    };
  }
  return {
    display: `${head}Send to @${d.to} · Edit · Cancel — nothing has been sent.  _(draft ${d.id} · rev ${rev})_`,
    data: { draft: { id: d.id, to: d.to, message, refs: d.refs || [], status: d.status, rev }, actions: [{ label: `Send to @${d.to}`, tool: 'vibe_send_draft', args: { id: d.id, rev } }, { label: 'Edit', tool: 'vibe_draft', args: { id: d.id, message: '<new text>' } }, { label: 'Cancel', tool: 'vibe_discard_draft', args: { id: d.id } }] },
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
  const message = typeof (args && args.message) === 'string' ? args.message.trim() : '';
  const wantId = args && args.id;

  const out = transact(drafts => {
    let d = wantId ? drafts.find(x => x.id === wantId) : null;
    if (wantId && !d) return { display: `No draft ${wantId} — it may have expired (drafts live 24h, locally). Run vibe_moves again or write the message.` };
    if (!d) {
      if (!args || !args.handle || !message) return { display: 'To open a draft: pass a move id, or a handle and a message. Nothing is sent by this step.' };
      const to = normalizeHandle(args.handle);
      if (to === me) return { display: "You can't draft to yourself." };
      // @echo is the feedback line with its own path and no receipt shape;
      // it is not a person to draft to (codex P2).
      if (to === 'echo') return { display: '@echo is the feedback line — send to it with vibe_dm directly. Nothing drafted.' };
      d = { id: newId('w'), status: 'previewed', createdAt: Date.now(), from: me, flow: FLOW, kind: 'free', to, why: 'you named them', body: message, refs: cleanContext({ refs: args.refs }).refs, context: { project: null } };
      drafts.push(d);
    } else {
      // A finished draft stays finished; an unconfirmed one may only be
      // retried as-is or cancelled (its idempotency key names THIS text).
      if (d.from && d.from !== me) return { display: `Draft ${d.id} was prepared as @${d.from}; you are signed in as @${me}. Nothing sent — open a new draft as yourself.` };
      if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — nothing changed. Open a new draft to say more.` };
      if (d.status === 'cancelled') return { display: `Draft ${d.id} was cancelled — open a new draft (vibe_draft with handle + message, or vibe_moves again). Nothing sent.` };
      if (d.status === 'sending') return { display: `Draft ${d.id} is being sent right now — nothing to edit.` };
      if (d.status === 'unknown' && (message || args.refs)) return { display: `Draft ${d.id}: the last Send to @${d.to} did not confirm, so the text is frozen — Send again to retry exactly that text (it delivers once), or Cancel. To say something different, cancel and open a new draft.` };
      if (d.status !== 'unknown') {
        if (message) { d.body = message; d.edited = true; }
        if (args.refs) { d.refs = cleanContext({ refs: args.refs }).refs; }
        d.status = 'previewed';
      }
    }
    if (compose(d).length > 2000) return { display: `Not ready — the message is ${compose(d).length} chars and the limit is 2000. Edit it shorter; nothing was sent.` };
    return { draft: { ...d } };
  });
  if (out.display) return out;
  return preview(out.draft, await findPerson(out.draft.to));
}

// ── vibe_discard_draft ───────────────────────────────────────────────────────

const discardDefinition = {
  name: 'vibe_discard_draft',
  description: 'Cancel a draft that has not been sent. Sends nothing; the draft stays on this machine only until it expires. A draft already being sent, or sent, cannot be cancelled — this says so instead of pretending.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

async function discardHandler(args) {
  const id = args && args.id;
  return transact(drafts => {
    const d = drafts.find(x => x.id === id);
    if (!d) return { display: `No draft ${id} to cancel — nothing was sent either way.` };
    if (d.status === 'sending') return { display: `Draft ${d.id} is being sent to @${d.to} right now — it can't be cancelled at this point.`, data: { draft: { id: d.id, status: d.status } } };
    if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — a sent message can't be unsent.`, data: { draft: { id: d.id, status: d.status } } };
    const wasUnknown = d.status === 'unknown';
    d.status = 'cancelled';
    return {
      display: wasUnknown
        ? `Cancelled — no further send to @${d.to}. Note: the earlier attempt did not confirm, so it may or may not have reached them.`
        : `Cancelled — nothing sent to @${d.to}. The draft stays on your machine.`,
      data: { draft: { id: d.id, status: 'cancelled' } },
    };
  });
}

// ── vibe_send_draft ──────────────────────────────────────────────────────────

const sendDefinition = {
  name: 'vibe_send_draft',
  description: "Send a reviewed draft exactly as previewed. This IS the person's approval — call it only when they chose \"Send to @handle\"; do not ask again afterward. Pass the draft id AND the rev shown in the preview: the approval is bound to that exact text, and a draft edited since is refused. Sends once through the ordinary message path (a retry of an unconfirmed send delivers once) and records a private, local note of the work it was sent from so the reply can be labeled.",
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, rev: { type: 'string', description: 'The rev from the preview the person approved' } }, required: ['id', 'rev'] },
};

async function sendHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;
  const id = args && args.id;
  const rev = typeof (args && args.rev) === 'string' ? args.rev.trim() : '';
  const me = config.getHandle();

  // 1. Claim under the lock: nothing leaves the machine until this draft is
  //    marked 'sending' with a key derived from the exact text — and the
  //    text is the one the person SAW (rev), not one edited since (codex P1).
  const claim = transact(drafts => {
    const d = drafts.find(x => x.id === id);
    if (!d) return { display: `No draft ${id} — nothing sent. Open it with vibe_draft first.` };
    // The approval was given as one account; it is not transferable to
    // whoever is signed in now (codex P1).
    if (d.from && d.from !== me) return { display: `Draft ${d.id} was prepared as @${d.from}; you are signed in as @${me}. Nothing sent — open a new draft as yourself.` };
    if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — not sending it twice.` };
    if (d.status === 'cancelled') return { display: `Draft ${d.id} was cancelled — nothing sent. Open a new draft if you want it back.` };
    if (d.status === 'suggested') return { display: `Draft ${d.id} has not been reviewed yet — open it with vibe_draft so you see the exact message first. Nothing sent.` };
    if (!rev) return { display: `Send needs the rev shown in the preview of draft ${d.id} — open it with vibe_draft and send with that rev. Nothing sent.` };
    if (rev !== revOf(d)) return { display: `Draft ${d.id} changed since that preview (rev ${rev} → ${revOf(d)}) — open it again with vibe_draft and approve what it shows now. Nothing sent.` };
    if (d.status === 'sending') {
      const age = Date.now() - (d.claimedAt || 0);
      const abandoned = age > CLAIM_HARD_STALE_MS || (age > CLAIM_STALE_MS && !pidAlive(d.claimedBy));
      if (!abandoned) return { display: `Draft ${d.id} is already being sent — not sending it twice.` };
      // The claiming process died mid-send: retry the SAME text under the
      // SAME key — the server deduplicates, so this delivers once (codex P2).
      // That earlier attempt may have committed: uncertainty is recorded
      // BEFORE the retry so a later definite refusal cannot erase it.
      d.unconfirmed = true;
    }
    d.status = 'sending'; d.claimedAt = Date.now(); d.claimedBy = process.pid;
    d.idempotencyKey = sendKey(d);
    return { snapshot: { id: d.id, to: d.to, kind: d.kind, body: d.body, refs: d.refs, context: d.context, message: compose(d), key: d.idempotencyKey } };
  });
  if (claim.display) return claim;
  const s = claim.snapshot;

  // 2. Deliver, outside the lock.
  let result;
  try {
    const dm = require('./dm');
    result = await dm.handler({ handle: s.to, message: s.message, origin: 'context_move', idempotency_key: s.key });
  } catch (e) {
    result = { display: `That didn't send — ${e && e.message ? e.message : 'unknown error'}. Nothing confirmed; the draft is still here.`, data: { sent: false, definite: false } };
  }
  const outcome = result && result.data && typeof result.data === 'object' ? result.data : {};
  const sent = outcome.sent === true;
  const definite = outcome.definite === true;

  // 3. Finalize against the LATEST stored state (other drafts may have
  //    changed meanwhile). A confirmed failure returns to 'previewed'; an
  //    unconfirmed one becomes 'unknown' — retry same text, or cancel.
  const sentAt = Date.now();
  transact(drafts => {
    const cur = drafts.find(x => x.id === s.id);
    if (!cur) return;
    // Uncertainty is sticky: once an attempt may have committed, a later
    // DEFINITE refusal says nothing about that earlier attempt (codex P2).
    if (!sent && !definite) cur.unconfirmed = true;
    cur.status = sent ? 'sent' : ((definite && !cur.unconfirmed) ? 'previewed' : 'unknown');
    delete cur.claimedAt; delete cur.claimedBy;
    if (sent) { cur.sentAt = sentAt; cur.messageId = outcome.message_id || null; }
  });
  if (sent) {
    withBindings(b => { b[s.to] = { project: s.context && s.context.project ? s.context.project : null, draftId: s.id, kind: s.kind, sentAt, messageId: outcome.message_id || null, firstLine: (s.body || '').split('\n')[0].slice(0, 80) }; });
  } else if (!definite && result && typeof result.display === 'string') {
    result = { ...result, display: `${result.display}\n\n_Draft ${s.id} is kept as unconfirmed: Send again retries exactly this text (delivers once), or Cancel._` };
  }
  return result;
}

module.exports = {
  definitions: [movesDefinition, draftDefinition, discardDefinition, sendDefinition],
  vibe_moves: { definition: movesDefinition, handler: movesHandler },
  vibe_draft: { definition: draftDefinition, handler: draftHandler },
  vibe_discard_draft: { definition: discardDefinition, handler: discardHandler },
  vibe_send_draft: { definition: sendDefinition, handler: sendHandler },
  // exported for tests and for vibe_inbox / vibe_dm
  computeMoves, cleanContext, getReturnBinding, clearReturnBinding, loadDrafts, transact, DRAFTS_FILE, BINDINGS_FILE,
};
