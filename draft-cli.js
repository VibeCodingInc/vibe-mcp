#!/usr/bin/env node
/**
 * vibe-draft — the terminal's drafts, for another surface on the same machine.
 *
 * Buddy (the Mac companion) shows the draft your coding agent prepared and lets
 * you decide there; this is how it does it WITHOUT becoming a second sender.
 * Every verb goes through the same store, the same lock, the same rev-bound
 * claim and the same approval digest as the terminal's own Send. One draft,
 * one sender, one digest — never two sends.
 *
 *   vibe-draft list                 previewed drafts for the signed-in account, as JSON
 *   vibe-draft send <id> <rev>      send exactly the revision that was shown
 *   vibe-draft discard <id>         cancel it (a discard in one window is a discard everywhere)
 *
 * Output is one JSON object on stdout. Exit 0 = the store answered (read the
 * object: sent may be false); exit 2 = bad usage; exit 1 = the store failed.
 */
const moves = require('./tools/moves');
const config = require('./config');

// stdout through a pipe can be asynchronous: exit only once the write has
// drained, or a large list is truncated mid-JSON (codex P2).
function out(obj, code = 0) {
  process.exitCode = code;
  process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(code));
}

/** The stored row's status now — what a companion surface must show, not the transport's word. */
function storedStatus(id) {
  // Read the stored row BEFORE the verb runs too, so a discard can say
  // whether the thing it cancelled had an unconfirmed attempt behind it.
  const d = moves.loadDrafts().find((x) => x.id === id);
  return d ? { status: d.status, unconfirmed: Boolean(d.unconfirmed) } : { status: null, unconfirmed: false };
}

async function main() {
  const [verb, id, rev] = process.argv.slice(2);
  const me = String(config.getHandle() || '').toLowerCase();
  if (!me) return out({ error: 'not_signed_in', message: 'no /vibe account on this machine' }, 1);

  if (verb === 'list') {
    // previewed = decidable; unknown = a send whose fate is unconfirmed — it
    // must stay reachable (Send again retries the same text; Discard is allowed)
    // rather than vanish from the companion while the terminal still holds it.
    // A claim whose process died stays 'sending' until someone reconciles it;
    // do that under the lock first, so an abandoned draft is listed as
    // 'unknown' (retry or discard) instead of hidden forever (codex r2).
    moves.transact((drafts) => { for (const d of drafts) moves.reconcileAbandoned(d); return drafts; });
    const mine = moves.loadDrafts().filter((d) => String(d.from || '').toLowerCase() === me && (d.status === 'previewed' || d.status === 'unknown'));
    // Exactly what the person would see in the terminal preview — and the rev
    // that binds a Send to those bytes. Nothing private: context stays out.
    const drafts = mine.map((d) => ({
      id: d.id, to: d.to, why: d.why || null, why_now: d.why_now || null,
      message: moves.compose(d),
      refs: (d.refs || []).map((r) => ({ title: r.title || null, url: r.url })),
      reply_to: d.replyTo || null, rev: moves.revOf(d), created_at: d.createdAt,
      status: d.status, unconfirmed: Boolean(d.unconfirmed),
    }));
    return out({ handle: me, drafts });
  }

  if (verb === 'send') {
    if (!id || !rev) return out({ error: 'usage', message: 'vibe-draft send <id> <rev>' }, 2);
    const r = await moves.vibe_send_draft.handler({ id, rev });
    const data = (r && r.data) || {};
    const stored = storedStatus(id);
    return out({ id, sent: Boolean(data.sent), message_id: data.message_id || null, status: stored.status, unconfirmed: stored.unconfirmed, display: r && r.display ? String(r.display) : null, definite: Boolean(data.definite) });
  }

  if (verb === 'discard') {
    if (!id) return out({ error: 'usage', message: 'vibe-draft discard <id>' }, 2);
    const before = storedStatus(id);
    const r = await moves.vibe_discard_draft.handler({ id });
    const stored = storedStatus(id);
    // A structured fact, not prose to be regex'd by a companion: was there an
    // earlier attempt whose delivery is unconfirmed? Cancelling only stops
    // future retries; the message may already have reached them.
    return out({ id, status: stored.status, cancelled: stored.status === 'cancelled', may_have_sent: Boolean(before.unconfirmed || stored.unconfirmed), display: r && r.display ? String(r.display) : null });
  }

  return out({ error: 'usage', message: 'vibe-draft list | send <id> <rev> | discard <id>' }, 2);
}

main().catch((e) => out({ error: 'store_failed', message: e && e.message ? e.message : String(e) }, 1));
