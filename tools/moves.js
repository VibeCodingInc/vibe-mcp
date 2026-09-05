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
const { canonicalHandle, storedRecipientHandle } = require('../protocol/handle');
const { inertField } = require('../incoming');

const DRAFTS_FILE = path.join(config.VIBE_DIR, 'drafts.json');
const BINDINGS_FILE = path.join(config.VIBE_DIR, 'return-bindings.json');
const MAX_MOVES = 3;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;         // a transaction never takes this long
const CLAIM_STALE_MS = 60 * 1000;        // a send claim older than this from a dead process is abandoned
const CLAIM_HARD_STALE_MS = 10 * 60 * 1000;
const THREAD_EVIDENCE_FRESH_MS = 7 * 24 * 60 * 60 * 1000; // someone who wrote you within a week is waiting; older needs topical overlap

// ── local, private state (one file, one lock, atomic replace) ────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // A process killed between write and rename leaves its .tmp; sweep any
  // older than a minute so they never accumulate (product-test finding).
  try {
    const dir = path.dirname(file); const base = path.basename(file);
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(`${base}.`) || !f.endsWith('.tmp')) continue;
      try { const st = fs.statSync(path.join(dir, f)); if (Date.now() - st.mtimeMs > 60_000) fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
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
/**
 * Ownership-checked lock (the pattern actor-session.js uses): the lock is a
 * directory (mkdir is atomic) holding an owner file {pid, nonce}. A stale
 * lock (owner dead, or too old) is reclaimed only by whoever still sees the
 * SAME owner it judged stale — so two waiters cannot both reclaim it — and
 * release removes the lock only if the nonce is still ours. Found by the
 * product-test session reading this file: the previous unlink-and-retry let
 * two waiters into the critical section together.
 */
function readOwner(lockDir) {
  try { return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')); } catch { return null; }
}
function locked(file, fn) {
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(6).toString('hex');
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), { mode: 0o600 });
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const owner = readOwner(lockDir);
      let age = Infinity;
      if (owner && typeof owner.at === 'number') age = Date.now() - owner.at;
      else { try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { age = Infinity; } }
      const stale = age > LOCK_STALE_MS || (owner && owner.pid && !pidAlive(owner.pid) && age > 250);
      if (stale) {
        // Reclaim only if the owner is still the one we judged stale.
        const now = readOwner(lockDir);
        const same = (!owner && !now) || (owner && now && owner.nonce === now.nonce);
        if (same) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${path.basename(file)} is busy — try again in a moment`);
      sleepSync(20);
    }
  }
  try { return fn(); } finally {
    const now = readOwner(lockDir);
    if (now && now.nonce === nonce) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} }
  }
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
/**
 * The private binding for a thread, if any, not expired, and made by the
 * account signed in NOW — another account in the same VIBE_HOME never sees
 * a previous account's project or excerpt (codex P2).
 */
function getReturnBinding(handle) {
  const raw = readJson(BINDINGS_FILE, {});
  const b = raw && typeof raw === 'object' ? raw[normalizeHandle(handle)] : null;
  if (!b || typeof b !== 'object' || !b.sentAt) return null;
  if (Date.now() - b.sentAt > BINDING_TTL_MS) return null;
  if (b.from && b.from !== config.getHandle()) return null;
  return b;
}
/** An ordinary DM to them supersedes the binding — the thread has moved on. */
function clearReturnBinding(handle) {
  const h = normalizeHandle(handle);
  const me = config.getHandle();
  withBindings(b => { if (b[h] && (!b[h].from || b[h].from === me)) delete b[h]; });
}
/** Retrying an unconfirmed send is safe only where the transport deduplicates by key. */
function transportDedupes() {
  return store.storage !== 'local' && process.env.VIBE_MESSAGES_V1 !== 'true';
}
/**
 * A 'sending' claim whose process died is reconciled to 'unknown' under the
 * lock, so preview and cancel see the truth instead of "being sent right now"
 * forever (codex P2). Returns true if it changed.
 */
function reconcileAbandoned(d) {
  if (!d || d.status !== 'sending') return false;
  const age = Date.now() - (d.claimedAt || 0);
  const abandoned = age > CLAIM_HARD_STALE_MS || (age > CLAIM_STALE_MS && !pidAlive(d.claimedBy));
  if (!abandoned) return false;
  d.status = 'unknown'; d.unconfirmed = true;
  delete d.claimedAt; delete d.claimedBy;
  return true;
}

const newId = (prefix) => `${prefix}${crypto.randomBytes(4).toString('hex')}`;
/** This process's flow: vibe_moves replaces only ITS OWN earlier suggestions (codex P2). */
const FLOW = `${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
const textHash = (d) => crypto.createHash('sha1').update(compose(d)).digest('hex');
const sendKey = (d) => `draft-${d.id}-${textHash(d).slice(0, 10)}`;
/**
 * The #392 approval digest over the EXACT snapshot the person approved:
 * SHA-256 of "<stored recipient>\n<body>", where the recipient is the form
 * the platform stores (lowercase, no @) and the body is the composed text
 * trimmed — exactly what vibe_dm sends. Computed once, at claim, from the
 * snapshot; never recomputed after a change to the previewed content.
 */
const approvedDigest = (to, message) => crypto.createHash('sha256').update(`${storedRecipientHandle(to)}\n${message}`, 'utf8').digest('hex');
/** The preview revision: what the person SAW. Send must name it (codex P1). */
const revOf = (d) => textHash(d).slice(0, 8);

// ── relevance: evidence, not inference ───────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what', 'when', 'have', 'just', 'some', 'more', 'than', 'then', 'them', 'they', 'your', 'will', 'been', 'were', 'also', 'like', 'make', 'made', 'work', 'working', 'building', 'build', 'thing', 'things', 'using', 'used', 'over', 'under', 'want', 'need', 'still', 'there', 'here', 'right', 'now', 'today']);

function tokens(text) {
  // Dots split as well as slashes: one-liners are often domains ("automata.art",
  // "katalog.chat") and must meet the plain word in someone's context.
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s./-]/g, ' ').split(/[\s/.]+/).map(w => w.replace(/^[-]+|[-]+$/g, '')).filter(w => w.length >= 4 && !STOP.has(w)));
}
function overlap(a, b) { const out = []; for (const w of a) if (b.has(w)) out.push(w); return out; }
function contextText(ctx) { return [ctx.project, ctx.doing, ctx.result, ctx.question, ctx.blocker].filter(Boolean).join(' '); }

// Field ceilings keep a draft inside the 2000-char message limit. A field
// over its ceiling is REPORTED, never silently cut: a draft that ends
// mid-word is not "the exact text you approve" (product-test finding —
// the previous 280-char slice produced "…and it judge").
const FIELD_MAX = { project: 60, doing: 300, result: 1500, question: 1500, blocker: 1500 };
function cleanContext(raw) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const tooLong = [];
  const str = (k, max) => {
    const v = ctx[k];
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const t = v.trim();
    if (t.length > max) { tooLong.push({ field: k, length: t.length, max }); return t; }
    return t;
  };
  const refs = Array.isArray(ctx.refs)
    ? ctx.refs.filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)).slice(0, 3).map(r => ({ title: (typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 80) : r.url), url: r.url.slice(0, 300) }))
    : [];
  return { project: str('project', FIELD_MAX.project), doing: str('doing', FIELD_MAX.doing), result: str('result', FIELD_MAX.result), question: str('question', FIELD_MAX.question), blocker: str('blocker', FIELD_MAX.blocker), refs, tooLong };
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
/**
 * The local store (VIBE_LOCAL=true) serves message records, not thread
 * summaries. Fold them into the summary shape computeMoves reads.
 */
function normalizeThreads(list, me) {
  if (!Array.isArray(list)) return [];
  if (list.every(t => t && typeof t === 'object' && 'handle' in t)) return list;
  const byPeer = new Map();
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const peer = m.from === me ? m.to : m.from;
    if (!peer) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : (m.created_at ? new Date(m.created_at).getTime() : 0);
    const cur = byPeer.get(peer);
    if (!cur || ts >= cur.lastTimestamp) byPeer.set(peer, { handle: peer, lastFrom: m.from, lastMessage: m.body, lastTimestamp: ts, unread: cur ? cur.unread : 0, isAgent: m.isAgent });
    if (m.from !== me && !m.read) byPeer.get(peer).unread += 1;
  }
  return [...byPeer.values()];
}

function computeMoves(ctx, me, roster, threads, now = Date.now(), { rosterKnown = true, actorKinds = null } = {}) {
  const hasContext = Boolean(ctx.result || ctx.question || ctx.blocker || ctx.doing);
  if (!hasContext) {
    return { ask: "What are you working on right now, in one line — and is there a result to share or a question to ask? (I'll only suggest people I can name a reason for.)" };
  }
  const ctxTok = tokens(contextText(ctx));
  const people = (roster || []).filter(u => u && u.handle && u.handle !== me && !u.isAgent);
  const byHandle = new Map(people.map(u => [u.handle, u]));
  const knownAgents = new Set((roster || []).filter(u => u && u.handle && u.isAgent).map(u => u.handle));
  if (actorKinds) for (const [h, k] of actorKinds) if (k && k !== 'human') knownAgents.add(h);
  const candidates = [];
  const unanswered = []; // fresh questions this work does not address — shown, never drafted

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
      // A stale thread is evidence only if it is about the work: filling a
      // slot with someone who wrote a month ago about something else is
      // not a move, it is noise (Seth's product test rule).
      const fresh = t.lastTimestamp ? (now - t.lastTimestamp) <= THREAD_EVIDENCE_FRESH_MS : false;
      const topical = overlap(ctxTok, tokens(String(t.lastMessage))).length > 0;
      if (!fresh && !topical) continue;
      // "Answer with the result" must actually answer: a fresh question the
      // work does not address is INFORMATION ("they asked you about X"), not
      // a draft that ships an unrelated result at them (Seth's product test,
      // 2026-09-04 21:14: Leo's vibeconferencing result offered as the answer
      // to a question about the drafts lock).
      if (!topical) {
        if (ctx.question || ctx.blocker) {
          candidates.push({ kind: 'ask', to: t.handle, why: `they wrote you${ageH != null ? ` ${ageH < 1 ? 'under an hour' : Math.round(ageH) + 'h'} ago` : ''} (their words): ${theirWords(t.lastMessage)} — not about this work, but they are here for you`, score: 2 + (ageH != null && ageH < 24 ? 1 : 0) });
        } else {
          unanswered.push({ to: t.handle, words: theirWords(t.lastMessage), ageH });
        }
        continue;
      }
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

  const note = unanswered.length
    ? `Also waiting on you, not about this work: ${unanswered.slice(0, 2).map(u => `@${u.to} asked ${u.words}`).join('; ')} — answer that separately when you have it.`
    : '';
  if (!candidates.length) {
    const topic = [...ctxTok].slice(0, 3).join(', ') || 'this';
    // An unreadable or anonymous roster is not an empty room (codex P2).
    if (!rosterKnown) return { ask: `Who is this for? I couldn't check who's around right now, so I won't guess — name a handle, or tell me who would care about ${topic}.${note ? ` ${note}` : ''}` };
    const around = people.filter(isHereNow).length;
    return { ask: `Who is this for? ${around ? `${around} ${around === 1 ? 'person is' : 'people are'} around` : 'Nobody is around right now'} and none of their one-liners touch ${topic} — name a handle, or tell me who would care.${note ? ` ${note}` : ''}` };
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
  return { moves, note };
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
  if (ctx.tooLong.length) {
    const f = ctx.tooLong[0];
    const ask = `The ${f.field} is ${f.length} characters; a message this long would be cut mid-sentence. Say it in under ${f.max} characters — what the other person needs to hear — or attach a link and keep the text short. Nothing drafted.`;
    return { display: ask, data: { ask, moves: [] } };
  }

  const [rosterRead, inboxRead] = await Promise.all([
    store.getActiveUsersResult ? store.getActiveUsersResult() : Promise.resolve({ ok: true, users: await store.getActiveUsers() }),
    store.getInboxResult ? store.getInboxResult(me) : Promise.resolve({ ok: true, threads: await store.getInbox(me) }),
  ]);
  // A signed-out read comes back ok:true with users.anonymous — counts only,
  // no people. That is "unknown", not "nobody".
  const rosterKnown = Boolean(rosterRead.ok && !(rosterRead.users && rosterRead.users.anonymous));
  const roster = rosterKnown ? rosterRead.users : [];
  const threads = normalizeThreads(inboxRead.ok ? inboxRead.threads : [], me);
  // Thread evidence needs actor attribution the thread list does not carry:
  // ask the served identity for each candidate peer (bounded, cached).
  const actorKinds = new Map();
  if (typeof store.getIdentityKind === 'function') {
    const peers = [...new Set(threads.filter(t => t && t.handle && t.lastFrom && t.lastFrom !== me).map(t => t.handle))].slice(0, 8);
    await Promise.all(peers.map(async h => { try { actorKinds.set(h, await store.getIdentityKind(h)); } catch { actorKinds.set(h, null); } }));
  }
  const evidenceNote = (!rosterKnown || !inboxRead.ok)
    ? `\n_(could not read ${[!rosterKnown && 'who is around', !inboxRead.ok && 'your inbox'].filter(Boolean).join(' or ')} — suggestions above use only what was readable)_`
    : '';

  const out = computeMoves(ctx, me, roster, threads, Date.now(), { rosterKnown, actorKinds });
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
  const display = `${moves.length === 1 ? 'One move' : `${moves.length} moves`} from what you're doing${ctx.project ? ` on ${ctx.project}` : ''} — nothing sent:\n\n${lines.join('\n\n')}\n\nPick one to see the exact message before anything goes out, write your own, or not now.${out.note ? `\n\n${out.note}` : ''}${evidenceNote}`;
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
    data: { draft: { id: d.id, to: d.to, body: d.body, message, refs: d.refs || [], status: d.status, rev }, actions: [{ label: `Send to @${d.to}`, tool: 'vibe_send_draft', args: { id: d.id, rev } }, { label: 'Edit', tool: 'vibe_draft', args: { id: d.id, message: '<new body text — links are kept separately>' } }, { label: 'Cancel', tool: 'vibe_discard_draft', args: { id: d.id } }] },
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
      const to = canonicalHandle(args.handle);
      if (!to) return { display: 'To open a draft: pass a move id, or a handle and a message. Nothing is sent by this step.' };
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
      reconcileAbandoned(d);
      if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — nothing changed. Open a new draft to say more.` };
      if (d.status === 'cancelled') return { display: d.unconfirmed
        ? `Draft ${d.id} was cancelled after a Send to @${d.to} that did not confirm — it may or may not have reached them. Open a new draft to say more.`
        : `Draft ${d.id} was cancelled — open a new draft (vibe_draft with handle + message, or vibe_moves again). Nothing sent.` };
      if (d.status === 'sending') return { display: `Draft ${d.id} is being sent right now — nothing to edit.` };
      if (d.status === 'unknown' && (message || args.refs)) return { display: `Draft ${d.id}: the last Send to @${d.to} did not confirm, so the text is frozen — Send again to retry exactly that text (it delivers once), or Cancel. To say something different, cancel and open a new draft.` };
      if (d.status !== 'unknown') {
        if (message) {
          // The preview's `message` already ends with the attachment lines;
          // an edit that pastes it back must not double them (codex P2).
          const tail = refLines(d.refs);
          d.body = tail && message.endsWith(tail) ? message.slice(0, -tail.length) : message;
          d.edited = true;
        }
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
    reconcileAbandoned(d);
    if (d.status === 'sending') return { display: `Draft ${d.id} is being sent to @${d.to} right now — it can't be cancelled at this point.`, data: { draft: { id: d.id, status: d.status } } };
    if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — a sent message can't be unsent.`, data: { draft: { id: d.id, status: d.status } } };
    if (d.status === 'cancelled') return { display: d.unconfirmed
      ? `Draft ${d.id} is already cancelled — and the earlier Send to @${d.to} did not confirm, so it may or may not have reached them.`
      : `Draft ${d.id} is already cancelled — nothing was sent.`, data: { draft: { id: d.id, status: d.status } } };
    const wasUnknown = d.status === 'unknown' || Boolean(d.unconfirmed);
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
      // The claiming process died mid-send: the SAME text under the SAME key
      // is what a retry would send. Uncertainty is recorded BEFORE the retry
      // so a later definite refusal cannot erase it.
      if (!reconcileAbandoned(d)) return { display: `Draft ${d.id} is already being sent — not sending it twice.` };
    }
    if (d.status === 'unknown' && !transportDedupes()) {
      // Without server-side deduplication a retry could deliver twice; the
      // honest options are to cancel (with the warning) or write anew.
      return { display: `Draft ${d.id}: the earlier Send to @${d.to} did not confirm, and this transport cannot deduplicate a retry. Cancel it (the earlier attempt may have reached them) and open a new draft if you still want to say it. Nothing sent.` };
    }
    d.status = 'sending'; d.claimedAt = Date.now(); d.claimedBy = process.pid;
    d.idempotencyKey = sendKey(d);
    const message = compose(d).trim();
    d.approvedSha256 = approvedDigest(d.to, message);
    return { snapshot: { id: d.id, to: d.to, kind: d.kind, body: d.body, refs: d.refs, context: d.context, message, key: d.idempotencyKey, approvedSha256: d.approvedSha256 } };
  });
  if (claim.display) return claim;
  const s = claim.snapshot;

  // 2. Deliver, outside the lock.
  let result;
  try {
    const dm = require('./dm');
    result = await dm.handler({ handle: s.to, message: s.message, origin: 'context_move', idempotency_key: s.key, approved_sha256: s.approvedSha256 });
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
    // The receipt is the fact; the binding is a convenience. A failure to
    // save it must never turn a confirmed delivery into an error (codex P2).
    try {
      withBindings(b => { b[s.to] = { from: me, project: s.context && s.context.project ? s.context.project : null, draftId: s.id, kind: s.kind, sentAt, messageId: outcome.message_id || null, firstLine: (s.body || '').split('\n')[0].slice(0, 80) }; });
    } catch (e) {
      result = { ...result, display: `${result.display}\n\n_(sent; could not save the local return note: ${e && e.message ? e.message : 'unknown'} — the reply will not be labeled with this work)_` };
    }
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
  computeMoves, cleanContext, normalizeThreads, getReturnBinding, clearReturnBinding, loadDrafts, transact, DRAFTS_FILE, BINDINGS_FILE,
};
