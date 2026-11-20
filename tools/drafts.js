/**
 * Drafts — "human-approved must not mean human-typed."
 *
 * The agent already helping someone work prepares a message; the person
 * chooses what crosses. This file is the whole approval mechanism:
 *
 *   vibe_prepare   the agent's words to a named person → the exact preview:
 *                  recipient, exact message, what it answers. NOTHING is
 *                  sent. Edit = call it again with new text.
 *   vibe_send      with a draft id + rev: the Send choice IS the approval.
 *                  Sends exactly the previewed text, once.
 *   vibe_discard   cancel. NOTHING is sent.
 *
 * Rules this file keeps:
 *  - Private stays private: drafts live in one local file. Rejected drafts
 *    never leave the machine.
 *  - The approval is bound to bytes: Send names the rev of the preview the
 *    person saw; a draft changed since is refused.
 *  - Exactly once: Send claims the draft under a whole-file lock, sends with
 *    an idempotency key derived from the exact text, and finalizes against
 *    the latest stored state. A draft whose delivery could not be confirmed
 *    can be retried (same text, same key) or cancelled, never edited.
 *
 * Draft states: previewed → sending → sent
 *                         ↘ cancelled   ↘ unknown (retry/cancel only)
 *
 * Held drafts: a draft to a handle /vibe says does not exist (a definite 404,
 * never a lookup that merely failed) and that is a GitHub login is HELD: Send
 * creates a thought-bearing invitation named for that GitHub account instead
 * of a message, so the exact approved text becomes the sender's first message
 * when that person signs in. previewed → sending → held. It is never "sent".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle, isHereNow } = require('./_shared');
const { canonicalHandle, storedRecipientHandle } = require('../protocol/handle');
const { inertField } = require('../incoming');
const { deliver } = require('./deliver');
const invite = require('../invite');

const DRAFTS_FILE = path.join(config.VIBE_DIR, 'drafts.json');
const BINDINGS_FILE = path.join(config.VIBE_DIR, 'return-bindings.json');
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;         // a transaction never takes this long
const CLAIM_STALE_MS = 60 * 1000;        // a send claim older than this from a dead process is abandoned
const CLAIM_HARD_STALE_MS = 10 * 60 * 1000;
/**
 * Known QA / probe traffic never drives an ordinary collaboration suggestion
 * (Astra, product test 2026-09-04): the platform quarantines these handles
 * from human interpretation surfaces (vibe-platform#307); the package keeps
 * the same line. Free writing to them still works — they are just never
 * proposed.
 */
const QA_HANDLE = /^(vibetester\d*|qa_[a-z0-9_-]+|[a-z0-9_-]*canary[a-z0-9_-]*|[a-z0-9_-]*_probe|synth_[a-z0-9_-]+|vibe-bot|vibe_bot)$/i;
function isQaHandle(h) { return QA_HANDLE.test(String(h || '').replace(/^@/, '')); }

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
// The reply target is part of what the person approves: answering a
// different message is a different act, so it changes the rev and the key.
// Holding a message for a newcomer is a different act from sending one, so
// it is part of the rev too (a held draft never shares a rev with a send).
const textHash = (d) => crypto.createHash('sha1').update(compose(d) + (d.replyTo ? `\n\u21a9${d.replyTo}` : '') + (d.held ? '\nheld-for-github' : '')).digest('hex');
const sendKey = (d) => `draft-${d.id}-${textHash(d).slice(0, 10)}`;
/**
 * The #392 approval digest over the EXACT snapshot the person approved:
 * SHA-256 of "<stored recipient>\n<body>", where the recipient is the form
 * the platform stores (lowercase, no @) and the body is the composed text
 * trimmed — exactly what deliver() sends. Computed once, at claim, from the
 * snapshot; never recomputed after a change to the previewed content.
 */
const approvedDigest = (to, message) => crypto.createHash('sha256').update(`${storedRecipientHandle(to)}\n${message}`, 'utf8').digest('hex');
/** The preview revision: what the person SAW. Send must name it (codex P1). */
const revOf = (d) => textHash(d).slice(0, 8);

// ── held: a message kept for someone not on /vibe yet ─────────────────────────
// Platform contract: api/invites.js (POST /api/invites with first_thought +
// for_github), api/lib/invitation-email.js (APPROVAL_RULE, approvalInput).

const HELD_DAYS = 30;
/** The platform's for_github shape (api/invites.js), applied to the canonical handle. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;
const isGithubLogin = (h) => GITHUB_LOGIN.test(String(h || ''));
/** generateCode(): 'VIBE-' + 4 of an unambiguous alphabet + '-' + the inviter handle's first 4. */
const INVITE_CODE = /^VIBE-[A-Z0-9]{4}-[A-Z0-9_-]{1,4}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * The platform's invitation approval digest (APPROVAL_RULE 'invitation-v1'):
 * sha256 over [rule, for_email, subject, text, html, open_note, question,
 * first_thought] joined by U+0000. A held draft carries only first_thought,
 * so every other field is the empty string. Note: for_github is NOT covered
 * by the platform digest; the recipient is bound here by the draft rev.
 */
const heldDigest = (firstThought) => crypto.createHash('sha256')
  .update(['invitation-v1', '', '', '', '', '', '', firstThought].join('\u0000'), 'utf8').digest('hex');
/** The handle the platform gives a GitHub login on first sign-in (handles.js normalizeHandle folds '-' to '_'). */
const handleForLogin = (login) => String(login || '').replace(/-/g, '_');

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
// ── vibe_prepare ───────────────────────────────────────────────────────────────

const draftDefinition = {
  name: 'vibe_prepare',
  description: "Prepare a message to a person for review. Sends NOTHING. Use this whenever YOU wrote the words (from the work in this session, or as an answer to a message that arrived): pass handle + message, and reply_to when it answers a specific message. Returns the exact preview and the three choices: Send / Edit / Cancel. To edit, call again with the draft id and the new message. If the handle is not on /vibe yet, the preview says so and the message is held for that GitHub account instead.",
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'Who it is for' },
      message: { type: 'string', description: 'The message: 1-3 plain sentences in the person\'s voice. No file paths, branch names, secrets or transcript text.' },
      reply_to: { type: 'string', description: 'The id of the message this answers, when it answers one' },
      project: { type: 'string', description: 'Optional: the name of the work this comes from, kept locally so the reply can be shown beside it. Never sent.' },
      refs: { type: 'array', description: 'Links the person explicitly wants attached', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
      id: { type: 'string', description: 'An existing draft id, to edit it' },
    },
  },
};

const cleanId = (v) => (typeof v === 'string' ? v.trim().replace(/^#/, '') : '') || null;

function preview(d, person) {
  const where = person ? (isHereNow(person) ? 'here now' : (person.status === 'away' ? 'away' : 'not around — it waits for their next turn')) : 'presence unknown — it waits for their next turn';
  const att = d.refs && d.refs.length ? d.refs.map(r => `${r.title}: ${r.url}`).join('\n') : 'none';
  const message = compose(d);
  const rev = revOf(d);
  const answers = d.replyTo ? `\n**Answers:** #${inertField(d.replyTo, 60)}` : '';
  const head = `**To:** @${d.to} (${where})\n**Message (exact):**\n${message}\n**Attachments:** ${att}${answers}\n\n`;
  if (d.status === 'unknown') {
    // The earlier Send did not confirm: it may already have reached them.
    // Only the two honest actions exist (codex P2).
    return {
      display: `${head}the last Send did not confirm — it may or may not have reached @${d.to}. Send again retries exactly this text (delivers once) · Cancel. Editing is off for this draft.  _(draft ${d.id} · rev ${rev})_`,
      data: { draft: { id: d.id, to: d.to, message, refs: d.refs || [], status: d.status, rev }, actions: [{ label: `Send to @${d.to} again`, tool: 'vibe_send', args: { id: d.id, rev } }, { label: 'Cancel', tool: 'vibe_discard', args: { id: d.id } }] },
    };
  }
  return {
    display: `${head}Send to @${d.to} · Edit · Cancel — nothing has been sent.  _(draft ${d.id} · rev ${rev})_`,
    data: { draft: { id: d.id, to: d.to, body: d.body, message, refs: d.refs || [], status: d.status, rev }, actions: [{ label: `Send to @${d.to}`, tool: 'vibe_send', args: { id: d.id, rev } }, { label: 'Edit', tool: 'vibe_prepare', args: { id: d.id, message: '<new body text — links are kept separately>' } }, { label: 'Cancel', tool: 'vibe_discard', args: { id: d.id } }] },
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

  // Is the person on /vibe at all? Asked only for a NEW draft to a handle
  // shaped like a GitHub login. Only a definite "no such handle" (404) makes
  // the draft held; a lookup that could not confirm keeps today's behaviour.
  //
  // A handle with a '-' is also addressed by the platform's spelling of it
  // (invite.resolveRecipient): the draft's `to`, its rev, its digest and the
  // stored recipient all use what the lookup answered. That one lookup also
  // serves the held check, so a prepare never asks twice.
  let absent = false;
  let resolvedTo = null;
  if (!wantId && args && args.handle && message) {
    const to = canonicalHandle(args.handle);
    // Someone you already know is on /vibe: no lookup, so the ordinary
    // preview costs no extra request and cannot be slowed by this one.
    let known = false;
    try { known = require('../reach').isKnown(to); } catch { known = false; }
    if (to && to !== me && to.includes('-') && !to.endsWith('/claude')) {
      const r = await invite.resolveRecipient(to);
      resolvedTo = r.handle;
      // Absent means the login as typed: a held draft is for that GitHub account.
      if (!known && isGithubLogin(to)) absent = Boolean(r.who && r.who.found === false);
    } else if (to && to !== me && to !== 'echo' && !known && isGithubLogin(to)) {
      try { absent = (await invite.lookup(to)).found === false; } catch { absent = false; }
    }
  }

  const out = transact(drafts => {
    let d = wantId ? drafts.find(x => x.id === wantId) : null;
    if (wantId && !d) return { display: `No draft ${wantId} — it may have expired (drafts live 24h, locally). Prepare it again.` };
    if (!d) {
      if (!args || !args.handle || !message) return { display: 'To prepare a message: pass a handle and a message (or a draft id to edit). Nothing is sent by this step.' };
      const to = resolvedTo || canonicalHandle(args.handle);
      if (!to) return { display: 'To prepare a message: pass a handle and a message (or a draft id to edit). Nothing is sent by this step.' };
      if (to === me) return { display: "You can't draft to yourself." };
      // @echo is the feedback line with its own path and no receipt shape;
      // it is not a person to draft to (codex P2).
      if (to === 'echo') return { display: '@echo is the feedback line. To write to it, send the person\'s own words with vibe_send (handle + message). Nothing drafted.' };
      // An approval-bound send targets a durable conversation; the live
      // session route stores nothing and the platform refuses it (CB-007).
      if (to.endsWith('/claude')) return { display: `Drafts go to a person's durable conversation, not a live session — use @${to.replace(/\/claude$/, '')} instead. Nothing drafted.` };
      const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim().slice(0, 60) : null;
      d = { id: newId('w'), status: 'previewed', createdAt: Date.now(), from: me, to, body: message, replyTo: cleanId(args.reply_to), refs: cleanContext({ refs: args.refs }).refs, context: { project } };
      // Nothing to answer in a conversation that does not exist yet.
      if (absent) { d.held = true; d.replyTo = null; }
      drafts.push(d);
    } else {
      // A finished draft stays finished; an unconfirmed one may only be
      // retried as-is or cancelled (its idempotency key names THIS text).
      if (d.from && d.from !== me) return { display: `Draft ${d.id} was prepared as @${d.from}; you are signed in as @${me}. Nothing sent — open a new draft as yourself.` };
      reconcileAbandoned(d);
      if (d.status === 'held') return { display: heldAlready(d) };
      if (d.held && d.status === 'unknown') return { display: heldUnknown(d) };
      if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — nothing changed. Open a new draft to say more.` };
      if (d.status === 'cancelled') return { display: d.unconfirmed
        ? `Draft ${d.id} was cancelled after a Send to @${d.to} that did not confirm — it may or may not have reached them. Open a new draft to say more.`
        : `Draft ${d.id} was cancelled — open a new draft (vibe_prepare with handle + message). Nothing sent.` };
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
        if (args.reply_to !== undefined && !d.held) d.replyTo = cleanId(args.reply_to);
        d.status = 'previewed';
      }
    }
    if (compose(d).length > 2000) return { display: `Not ready — the message is ${compose(d).length} chars and the limit is 2000. Edit it shorter; nothing was sent.` };
    return { draft: { ...d } };
  });
  if (out.display) return out;
  if (out.draft.held) return heldPreview(out.draft);
  return preview(out.draft, await findPerson(out.draft.to));
}

function heldPreview(d) {
  const att = d.refs && d.refs.length ? d.refs.map(r => `${r.title}: ${r.url}`).join('\n') : 'none';
  const message = compose(d);
  const rev = revOf(d);
  return {
    display: `**To:** @${d.to} (not on /vibe yet)\n**Message (exact):**\n${message}\n**Attachments:** ${att}\n\n`
      + `@${d.to} is not on /vibe yet. If you keep it, this exact message is held for the GitHub account ${d.to} for ${HELD_DAYS} days and arrives as your first message when they sign in to /vibe with that account. You get a link to pass on to them.\n\n`
      + `Keep for @${d.to} · Edit · Cancel — nothing has been sent.  _(draft ${d.id} · rev ${rev})_`,
    data: {
      draft: { id: d.id, to: d.to, body: d.body, message, refs: d.refs || [], status: d.status, rev, held: true, for_github: d.to },
      actions: [{ label: `Keep for @${d.to}`, tool: 'vibe_send', args: { id: d.id, rev } }, { label: 'Edit', tool: 'vibe_prepare', args: { id: d.id, message: '<new body text — links are kept separately>' } }, { label: 'Cancel', tool: 'vibe_discard', args: { id: d.id } }],
    },
  };
}
function heldAlready(d) {
  return `Draft ${d.id} is already held for @${d.to} — not creating a second invitation.${d.joinUrl ? ` Join link: ${d.joinUrl}` : ''}`;
}
function heldUnknown(d) {
  return `Draft ${d.id}: the last Keep for @${d.to} did not confirm — the invitation may or may not have been created, and a second try could create two. Cancel it, then open a new draft if you still want to say it. Nothing more was done.`;
}

// ── vibe_discard ───────────────────────────────────────────────────────

const discardDefinition = {
  name: 'vibe_discard',
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
    if (d.status === 'held') return { display: `Draft ${d.id} is already held for @${d.to} — a held message can't be taken back from here.`, data: { draft: { id: d.id, status: d.status } } };
    if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — a sent message can't be unsent.`, data: { draft: { id: d.id, status: d.status } } };
    if (d.status === 'cancelled') return { display: d.unconfirmed
      ? `Draft ${d.id} is already cancelled — and the earlier Send to @${d.to} did not confirm, so it may or may not have reached them.`
      : `Draft ${d.id} is already cancelled — nothing was sent.`, data: { draft: { id: d.id, status: d.status } } };
    const wasUnknown = d.status === 'unknown' || Boolean(d.unconfirmed);
    d.status = 'cancelled';
    if (d.held) {
      return {
        display: wasUnknown
          ? `Cancelled — nothing more will be done for @${d.to}. Note: the earlier Keep did not confirm, so an invitation may or may not have been created.`
          : `Cancelled — nothing kept for @${d.to}. The draft stays on your machine.`,
        data: { draft: { id: d.id, status: 'cancelled' } },
      };
    }
    return {
      display: wasUnknown
        ? `Cancelled — no further send to @${d.to}. Note: the earlier attempt did not confirm, so it may or may not have reached them.`
        : `Cancelled — nothing sent to @${d.to}. The draft stays on your machine.`,
      data: { draft: { id: d.id, status: 'cancelled' } },
    };
  });
}

// ── vibe_send ──────────────────────────────────────────────────────────

const sendDefinition = {
  name: 'vibe_send',
  description: "Send a message to a person. Two forms. (1) A prepared draft: pass id AND rev from the preview. Call this only when the person chose Send; that choice is the approval, do not ask again. (2) Words the person themselves stated, verbatim: pass handle + message (and reply_to when answering a specific message). Never use form 2 for words you wrote: prepare those with vibe_prepare so the person sees them first.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Draft id (form 1)' },
      rev: { type: 'string', description: 'The rev from the preview the person approved (form 1)' },
      handle: { type: 'string', description: 'Recipient (form 2)' },
      message: { type: 'string', description: "The person's own words, exactly (form 2)" },
      reply_to: { type: 'string', description: 'The id of the message this answers (form 2)' },
    },
  },
};
async function sendHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;
  const id = args && args.id;
  const rev = typeof (args && args.rev) === 'string' ? args.rev.trim() : '';
  const me = config.getHandle();

  // Form 2: the person's own words. Their saying them is the approval.
  if (!id) {
    if (!args || !args.handle || typeof args.message !== 'string' || !args.message.trim()) {
      return { display: 'Nothing sent. Pass a draft id and rev, or a handle and the exact message.' };
    }
    // Addressed by the platform's spelling when the handle has a '-'
    // (invite.resolveRecipient). Done here, not in deliver: a draft's digest
    // is computed over its `to` before deliver runs, so deliver must not
    // change the recipient.
    let to = canonicalHandle(args.handle);
    if (to && to !== canonicalHandle(me || '') && !to.endsWith('/claude')) {
      try { to = (await invite.resolveRecipient(to)).handle; } catch (e) {}
    }
    const result = await deliver({ to: to || args.handle, message: args.message, replyTo: cleanId(args.reply_to) });
    // The thread has moved on: what they say next answers THIS.
    if (result.data && result.data.sent) { try { clearReturnBinding(to || args.handle); } catch (e) {} }
    return result;
  }

  // 1. Claim under the lock: nothing leaves the machine until this draft is
  //    marked 'sending' with a key derived from the exact text — and the
  //    text is the one the person SAW (rev), not one edited since (codex P1).
  const claim = transact(drafts => {
    const d = drafts.find(x => x.id === id);
    if (!d) return { display: `No draft ${id} — nothing sent. Open it with vibe_prepare first.` };
    // The approval was given as one account; it is not transferable to
    // whoever is signed in now (codex P1).
    if (d.from && d.from !== me) return { display: `Draft ${d.id} was prepared as @${d.from}; you are signed in as @${me}. Nothing sent — open a new draft as yourself.` };
    if (d.status === 'held') return { display: heldAlready(d) };
    if (d.status === 'sent') return { display: `Draft ${d.id} was already sent to @${d.to} — not sending it twice.` };
    if (d.status === 'cancelled') return { display: `Draft ${d.id} was cancelled — nothing sent. Open a new draft if you want it back.` };
    if (!rev) return { display: `Send needs the rev shown in the preview of draft ${d.id} — open it with vibe_prepare and send with that rev. Nothing sent.` };
    if (rev !== revOf(d)) return { display: `Draft ${d.id} changed since that preview (rev ${rev} → ${revOf(d)}) — open it again with vibe_prepare and approve what it shows now. Nothing sent.` };
    if (d.status === 'sending') {
      // The claiming process died mid-send: the SAME text under the SAME key
      // is what a retry would send. Uncertainty is recorded BEFORE the retry
      // so a later definite refusal cannot erase it.
      if (!reconcileAbandoned(d)) return { display: `Draft ${d.id} is already being sent — not sending it twice.` };
    }
    // POST /api/invites has no idempotency key: an unconfirmed Keep is never
    // retried, because a retry could create a second invitation.
    if (d.held && d.status === 'unknown') return { display: heldUnknown(d) };
    if (d.status === 'unknown' && !transportDedupes()) {
      // Without server-side deduplication a retry could deliver twice; the
      // honest options are to cancel (with the warning) or write anew.
      return { display: `Draft ${d.id}: the earlier Send to @${d.to} did not confirm, and this transport cannot deduplicate a retry. Cancel it (the earlier attempt may have reached them) and open a new draft if you still want to say it. Nothing sent.` };
    }
    d.status = 'sending'; d.claimedAt = Date.now(); d.claimedBy = process.pid;
    d.idempotencyKey = sendKey(d);
    const message = compose(d).trim();
    d.approvedSha256 = d.held ? heldDigest(message) : approvedDigest(d.to, message);
    return { snapshot: { id: d.id, to: d.to, body: d.body, refs: d.refs, context: d.context, replyTo: d.replyTo || null, message, key: d.idempotencyKey, approvedSha256: d.approvedSha256, held: Boolean(d.held) } };
  });
  if (claim.display) return claim;
  const s = claim.snapshot;
  if (s.held) return keepHeld(s, me);

  // 2. Deliver, outside the lock.
  let result;
  try {
    result = await deliver({ to: s.to, message: s.message, replyTo: s.replyTo, origin: 'context_move', idempotencyKey: s.key, approvedSha256: s.approvedSha256 });
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
      withBindings(b => { b[s.to] = { from: me, project: s.context && s.context.project ? s.context.project : null, draftId: s.id, sentAt, messageId: outcome.message_id || null, firstLine: (s.body || '').split('\n')[0].slice(0, 80) }; });
    } catch (e) {
      result = { ...result, display: `${result.display}\n\n_(sent; could not save the local return note: ${e && e.message ? e.message : 'unknown'} — the reply will not be labeled with this work)_` };
    }
  } else if (!definite && result && typeof result.display === 'string') {
    result = { ...result, display: `${result.display}\n\n_Draft ${s.id} is kept as unconfirmed: Send again retries exactly this text (delivers once), or Cancel._` };
  }
  return result;
}

// ── Keep: create the invitation that holds the approved message ───────────────

/**
 * One fix per refusal, built from the status and the platform's stable error
 * token only — server prose is never shown. Every refusal here is definite:
 * it comes from a reply the platform sent before anything was minted.
 */
function heldRefusal(r) {
  const status = r && r.statusCode;
  const nothing = 'Nothing was kept.';
  if (status === 401) return `${nothing} /vibe does not see you signed in. Run \`npx slashvibe-mcp setup\` in a terminal to sign in, then keep it again.`;
  if (status === 403) return `${nothing} Holding a message for someone needs a fresh sign-in on this machine. Run \`npx slashvibe-mcp setup\` in a terminal, then keep it again.`;
  if (status === 400 && r.error === 'No invite codes remaining') return `${nothing} You already have 3 unused invitations, the most /vibe allows at once. Pass on one of the links you already have; a slot opens when someone signs in with one or it expires after ${HELD_DAYS} days.`;
  if (status === 400 && typeof r.error === 'string' && /^first_thought is \d+ chars/.test(r.error)) return `${nothing} The message is over the 2000-char limit. Edit it shorter, then keep it again.`;
  if (status === 409 && r.error === 'approval_mismatch') return `${nothing} What /vibe would store is not what you approved. Open the draft again with vibe_prepare and approve what it shows now.`;
  return `${nothing} /vibe refused the invitation${status ? ` (HTTP ${status})` : ''}. Try again in a moment.`;
}

async function keepHeld(s, me) {
  let outcome; // { held: true, code, expiresAt } | { definite: bool, display, cancel? }
  try {
    outcome = await createHeld(s);
  } catch (e) {
    outcome = { definite: false, display: 'The invitation could not be confirmed — it may or may not have been created.' };
  }

  const at = Date.now();
  const joinUrl = outcome.held ? `https://www.slashvibe.dev/join/${outcome.code}` : null;
  transact(drafts => {
    const cur = drafts.find(x => x.id === s.id);
    if (!cur) return;
    delete cur.claimedAt; delete cur.claimedBy;
    if (outcome.held) { cur.status = 'held'; cur.heldAt = at; cur.joinUrl = joinUrl; cur.expiresAt = outcome.expiresAt || null; return; }
    if (!outcome.definite) { cur.unconfirmed = true; cur.status = 'unknown'; return; }
    cur.status = outcome.cancel ? 'cancelled' : (cur.unconfirmed ? 'unknown' : 'previewed');
  });

  if (!outcome.held) {
    const tail = outcome.definite ? '' : `\n\n_Draft ${s.id} is kept as unconfirmed. Keeping it again could create a second invitation, so the only choice left is Cancel._`;
    return { display: `${outcome.display}${tail}`, data: { sent: false, held: false, definite: Boolean(outcome.definite) } };
  }

  const until = outcome.expiresAt ? `, until ${outcome.expiresAt}` : '';
  const pass = invite.line(me);
  const lines = [
    `Held for @${s.to}. /vibe created the invitation.`,
    `**Join link:** ${joinUrl}`,
  ];
  if (pass) lines.push(`**Pass on with it:** ${pass.command}`);
  lines.push(`Your message is kept for the GitHub account ${s.to} for ${HELD_DAYS} days${until}. It arrives as your first message when they sign in to /vibe with that account; nothing reaches them before then.`);

  // Writing to someone is what lets their answer reach you mid-work. Their
  // handle does not exist yet: it will be their GitHub login with '-' folded
  // to '_' (the platform's first-sign-in rule), so that is the one marked.
  try { require('../reach').know(handleForLogin(s.to)); } catch (e) {}

  return {
    display: lines.join('\n'),
    data: { sent: false, held: true, definite: true, for_github: s.to, join_url: joinUrl, expires_at: outcome.expiresAt || null },
  };
}

/**
 * dry_run first (side-effect free: the platform checks sign-in, the unused-
 * code cap and the thought before it answers), confirm its digest is the one
 * computed from the approved snapshot, then create with approved_sha256 so
 * the platform refuses anything other than what was previewed.
 */
async function createHeld(s) {
  if (typeof store.createInvite !== 'function') return { definite: true, display: 'Nothing was kept. Holding a message for someone needs the /vibe service; this session is in local mode.' };
  const thought = s.message;
  if (thought.length > 2000) return { definite: true, display: `Nothing was kept. The message is ${thought.length} chars and the limit is 2000. Edit it shorter, then keep it again.` };
  if (thought.includes('\u0000') || LONE_SURROGATE.test(thought)) return { definite: true, display: 'Nothing was kept. The message has a character /vibe cannot keep. Edit it, then keep it again.' };

  // They may have joined since the preview: then this is a message, not an invitation.
  const who = await invite.lookup(s.to).catch(() => ({ found: null }));
  if (who.found === true) return { definite: true, cancel: true, display: `Nothing was kept. @${s.to} joined /vibe since you saw the preview, so this draft is cancelled. Prepare it again and it goes to them directly.` };

  const body = { first_thought: thought, for_github: s.to };
  const dry = await store.createInvite({ ...body, dry_run: true });
  if (!dry || dry.success !== true) {
    if (dry && dry.statusCode) return { definite: true, display: heldRefusal(dry) };
    return { definite: true, display: 'Nothing was kept. /vibe could not be reached. Try again in a moment.' };
  }
  const serverSha = dry.approval && typeof dry.approval.sha256 === 'string' ? dry.approval.sha256 : null;
  if (dry.dry_run !== true || dry.carries_thought !== true || dry.named_for !== s.to || serverSha !== s.approvedSha256) {
    return { definite: true, display: heldRefusal({ statusCode: 409, error: 'approval_mismatch' }) };
  }

  const made = await store.createInvite({ ...body, approved_sha256: s.approvedSha256 });
  if (made && made.success === true) {
    // Created only on the served truth: a code of the platform's shape, named
    // for this login, carrying the thought. Anything else may have minted
    // something, so it is unconfirmed, never success.
    const code = typeof made.code === 'string' ? made.code : '';
    if (INVITE_CODE.test(code) && made.carries_thought === true && made.named_for === s.to) {
      const t = Date.parse(made.expires_at);
      return { held: true, code, expiresAt: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null };
    }
    return { definite: false, display: '/vibe answered, but not with an invitation held for this account. It may or may not have been created.' };
  }
  // A reply with a 4xx status, or a 503 (both of its paths say nothing was
  // saved), was decided before anything was minted. No reply, or a crash,
  // leaves it open.
  const st = made && made.statusCode;
  if (st && (st < 500 || st === 503)) return { definite: true, display: heldRefusal(made) };
  return { definite: false, display: 'The invitation could not be confirmed — it may or may not have been created.' };
}

module.exports = {
  vibe_prepare: { definition: draftDefinition, handler: draftHandler },
  vibe_send: { definition: sendDefinition, handler: sendHandler },
  vibe_discard: { definition: discardDefinition, handler: discardHandler },
  // for the arrival path, the thread view, and Buddy's `vibe-draft` CLI
  isQaHandle, getReturnBinding, clearReturnBinding, loadDrafts, transact, DRAFTS_FILE, BINDINGS_FILE,
  compose, revOf, reconcileAbandoned,
};
