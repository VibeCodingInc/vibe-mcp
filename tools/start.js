/**
 * vibe_start — sign in, and say what is waiting.
 *
 * One screen: who you are, how many people are in a session, what is unread,
 * and which conversations ended on their words. Handles, counts, ages and
 * ids only. The words themselves stay in the thread until it is opened, and
 * nobody is suggested: who to talk to is the person's decision.
 */

'use strict';

const config = require('../config');
const { inertField } = require('../incoming');
const store = require('../store');
const { isHereNow, normalizeHandle } = require('./_shared');
const init = require('./init');
const { gatherWithTimeout } = require('./_work-context');
const { wroteLastPeople } = require('../arrival');
const { isQaHandle } = require('./drafts');
const line = require('../line');

const definition = {
  name: 'vibe_start',
  description: 'Sign in to /vibe, or if already signed in, see what is waiting: unread conversations and ones that ended on the other person\'s words. Use when the person says "let\'s vibe", "sign in to /vibe", or asks what is waiting for them.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'Only when signing in for the first time' },
      building: { type: 'string', description: 'One line on what you are working on. Only when signing in for the first time.' },
    },
  },
};

async function handler(args = {}) {
  // Signed out: straight to the (non-blocking) sign-in. Nothing slow may sit
  // between a newcomer and their first actionable line.
  if (!config.hasOAuth()) {
    return init.handler({ handle: args.handle, one_liner: args.building });
  }

  const myHandle = config.getHandle();
  const me = normalizeHandle(myHandle || '');

  // What other people's agents will be told you are working on: a short note
  // derived from the repo you are in (redacted and capped in _work-context).
  // Opt out with `autoContext: false` in config.
  if (config.get('autoContext', true)) {
    gatherWithTimeout(2000).then((work) => {
      if (work?.suggestions?.brief) {
        return store.heartbeat(myHandle, config.getOneLiner(), { note: work.suggestions.brief, branch: null });
      }
    }).catch(() => {});
  }

  // A read that FAILED is not an empty room and not an empty inbox: both
  // outcomes are kept, and an unknown is shown as unknown, never as zero.
  const [presence, inbox] = await Promise.all([
    store.getActiveUsersResult().catch(() => ({ ok: false, users: [] })),
    store.getInboxResult(myHandle).catch(() => ({ ok: false, threads: [] })),
  ]);
  const presenceRead = presence.ok === true;
  const inboxRead = inbox.ok === true;
  const threads = inboxRead ? (inbox.threads || []) : [];
  const hereCount = presenceRead
    ? (presence.users || []).filter((u) => normalizeHandle(u.handle || '') !== me && isHereNow(u)).length
    : 0;
  const unreadCount = threads.reduce((sum, t) => sum + (t.unread || 0), 0);
  const unreadSenders = threads.filter((t) => t.unread > 0);
  // Server-supplied strings on one line each: a control character must not
  // add a row and a long handle must not wrap.
  const cell = (v, max) => inertField(String(v || ''), max);

  let display = `/vibe @${cell(myHandle, 39)}`;
  display += `\n${[
    inboxRead ? `${unreadCount} unread` : "couldn't read your conversations",
    presenceRead ? `${hereCount} other${hereCount === 1 ? '' : 's'} here` : "couldn't see who's here",
  ].join(' · ')}`;

  if (unreadSenders.length > 0) {
    display += '\n';
    unreadSenders.slice(0, 5).forEach((t) => {
      display += `\n@${cell(t.handle, 39)} (${t.unread})${t.lastMessageId ? ` · #${cell(t.lastMessageId, 40)}` : ''}`;
    });
    if (unreadSenders.length > 5) display += `\n_+${unreadSenders.length - 5} more_`;
  } else if (inboxRead && threads.length === 0) {
    display += '\n\n_no conversations yet. Whoever invited you is the place to start._';
  }

  // Conversations that ended on their words and were read: "unread" alone
  // lets those vanish. A fact from the wire, not a claim that a reply is owed.
  const lastWord = inboxRead
    ? await wroteLastPeople(threads, myHandle, { isQa: isQaHandle, kindOf: store.getIdentityKind })
    : [];
  if (lastWord.length > 0) {
    display += '\n\nthey wrote last:';
    lastWord.forEach((t) => {
      display += `\n@${cell(t.handle, 39)} · ${t.days}d ago${t.lastMessageId ? ` · #${cell(t.lastMessageId, 40)}` : ''}`;
    });
  }

  // What this person's agent said for them over an open line since yesterday.
  // Their own agent's words, so shown in full: nobody else reviewed them.
  const spoken = line.receipts().filter((r) => r.kind === 'answered' || r.kind === 'asked').slice(-5);
  if (spoken.length > 0) {
    display += '\n\nover your open lines, your agent:';
    spoken.forEach((r) => {
      display += r.kind === 'answered'
        ? `\nanswered @${cell(r.with, 39)}, who asked "${cell(r.asked, 100)}": "${cell(r.said, 200)}"`
        : `\nasked @${cell(r.with, 39)}: "${cell(r.said, 200)}"`;
    });
  }

  display += '\n\nopen a conversation: vibe thread @handle · see who is reachable: vibe people';

  // The payload says exactly what the screen says: a body withheld from the
  // display but shipped here would not be withheld at all.
  return {
    display,
    unread: inboxRead ? unreadCount : null,   // null = not read, never 0
    here: presenceRead ? hereCount : null,
    waiting: unreadSenders.slice(0, 5).map((t) => ({ handle: t.handle, unread: t.unread, lastMessageId: t.lastMessageId || null })),
    wroteLast: lastWord,
    lineReceipts: spoken.map((r) => ({ kind: r.kind, with: r.with, at: r.at })),
  };
}

module.exports = { definition, handler };
