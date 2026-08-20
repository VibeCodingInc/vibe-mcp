/**
 * Render the default MCP surface against synthetic data.
 *
 * One harness, two jobs:
 *
 *   node scripts/render-states.mjs all        every kernel state (the UX audit)
 *   node scripts/render-states.mjs <state>    one state
 *   node scripts/render-states.mjs demo       the two-person asynchronous round
 *                                             trip, both terminals, in order —
 *                                             regenerates docs/DEMO-TRANSCRIPT.md
 *
 * No real handles, no real messages, no network. The cast — @ada, @rune, @juno,
 * @mira, and the agent @atlas — and the one decision they trade (a migration
 * question, answered asynchronously) are synthetic, matching the demo
 * narrative's shape without reusing anything from production.
 *
 * Field names mirror what store/api.js actually emits (isAgent camelCase;
 * thread messages carry body + timestamp; thread summaries lastMessage +
 * lastTimestamp) — an earlier draft used invented names and audited fixture
 * bugs instead of the product.
 *
 * VIBE_AS=<handle> sets whose terminal is rendering (default ada). demo mode
 * re-invokes itself with the right identity per beat.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MCP = path.resolve(path.dirname(SELF), '..');
const require = createRequire(path.join(MCP, 'x.js'));

const ME = process.env.VIBE_AS || 'ada';

// A throwaway HOME so nothing reads or writes a real config.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-render-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sub) => `h.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const ONE_LINERS = { ada: 'migration cleanup', rune: 'schema + rollback tests' };
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: ME, authToken: token(ME), one_liner: ONE_LINERS[ME] || 'building',
}));

// Nothing leaves this process.
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require(path.join(MCP, 'store', 'api.js'));
const { renderIncoming } = require(path.join(MCP, 'incoming.js'));
const now = Date.now();
const mins = (n) => now - n * 60_000;

/** Synthetic cast. Nobody real; nothing recognisable from production. */
const CAST = {
  ada:   { handle: 'ada',   one_liner: 'migration cleanup',       lastSeen: mins(1),  status: 'active', isAgent: false },
  rune:  { handle: 'rune',  one_liner: 'schema + rollback tests', lastSeen: mins(2),  status: 'active', isAgent: false },
  juno:  { handle: 'juno',  one_liner: 'docs pass',               lastSeen: mins(38), status: 'away',   isAgent: false },
  // The server calls anyone seen <30m "active" — mira closed her laptop 25
  // minutes ago and still arrives in the active lane. The stale-green case.
  mira:  { handle: 'mira',  one_liner: 'ci triage',               lastSeen: mins(25), status: 'active', isAgent: false },
  atlas: { handle: 'atlas', one_liner: 'reviewing migrations',    lastSeen: mins(1),  status: 'active', isAgent: true, operator: 'rune' },
};
const runeAway = { ...CAST.rune, status: 'away', lastSeen: mins(47) };

const ASK = 'can this migration drop legacy_status? the rollback test is the only thing still failing';
const ANSWER = 'yes — the rollback test still reads the old column. update that fixture first, then the column is safe to remove';
const THREAD = [
  { from: 'ada',  body: ASK,    timestamp: mins(95), read: true },
  { from: 'rune', body: ANSWER, timestamp: mins(4),  read: false },
];

/** Swap the store's network calls for fixtures. */
function fixture({ users = [], unread = 0, threads = [], thread = [], anonymous = false } = {}) {
  const arr = users.map((u) => ({ ...u }));
  Object.defineProperties(arr, {
    anonymous: { value: anonymous, enumerable: false },
    counts: { value: anonymous ? { active: users.length } : null, enumerable: false },
  });
  store.getActiveUsers = async () => arr;
  store.getUnreadCount = async () => unread;
  store.getInbox = async () => threads;
  store.getRawInbox = async () => [];
  store.getThread = async () => thread;
  store.getPresence = async () => ({ active: users.filter(u => u.status === 'active'), away: users.filter(u => u.status !== 'active') });
  store.getTypingUsers = async () => [];
  store.markThreadRead = async () => {};
  store.trackChecklistCompletion = async () => {};
  store.getOnboardingData = async () => ({});
  store.heartbeat = async () => ({ ok: true });
  store.getLiveBroadcastCount = async () => 0;
  store.sendTypingIndicator = async () => {};
  store.setAwayStatus = async () => {};
  store.clearAwayStatus = async () => {};
  store.setNotificationPace = async () => ({ success: true });
}

const fresh = (t) => { delete require.cache[require.resolve(path.join(MCP, 'tools', `${t}.js`))]; return require(path.join(MCP, 'tools', `${t}.js`)); };
const show = (label, out) => {
  const body = typeof out === 'string' ? out : (out?.display ?? JSON.stringify(out, null, 2));
  console.log(`\n${'─'.repeat(72)}\n▌ ${label}\n${'─'.repeat(72)}`);
  console.log(body.replace(/\x1b\][^\x07]*\x07/g, ''));   // strip terminal escapes
};

const STATES = {
  async help() { show('help', await fresh('help').handler({})); },

  async 'who-empty'() {
    fixture({ users: [] });
    show('who · signed in, nobody else here', await fresh('who').handler({}));
  },
  async 'who-signed-out'() {
    fixture({ users: [], anonymous: true });
    show('who · signed out', await fresh('who').handler({}));
  },
  async 'who-populated'() {
    fixture({ users: [CAST.rune, CAST.juno, CAST.atlas], unread: 1 });
    show('who · two people and an agent', await fresh('who').handler({}));
  },
  async 'who-collaborator-away'() {
    fixture({ users: [runeAway, CAST.juno, CAST.atlas] });
    show('who · the collaborator you need is away', await fresh('who').handler({}));
  },
  async 'who-stale-green'() {
    fixture({ users: [CAST.rune, CAST.mira] });
    show('who · mira last seen 25m ago, server still says active', await fresh('who').handler({}));
  },

  async 'inbox-arrived'() {
    fixture({ users: [], threads: [] });
    show('inbox · just arrived, nothing missed', await fresh('inbox').handler({}));
  },
  async 'inbox-caught-up'() {
    fixture({ users: [CAST.rune], threads: [{ handle: 'rune', lastMessage: 'thanks', unread: 0, lastTimestamp: mins(120) }] });
    show('inbox · read everything, history exists', await fresh('inbox').handler({}));
  },
  async 'inbox-waiting'() {
    fixture({
      users: [CAST.rune],
      unread: 1,
      threads: [{ handle: 'rune', lastMessage: THREAD[1].body, unread: 1, lastTimestamp: mins(4) }],
      thread: THREAD,
    });
    show('inbox · one answer waiting', await fresh('inbox').handler({}));
  },
  async 'inbox-thread'() {
    fixture({ users: [CAST.rune], unread: 1, threads: [{ handle: 'rune', lastMessage: THREAD[1].body, unread: 1, lastTimestamp: mins(4) }], thread: THREAD });
    show('inbox · reading the thread', await fresh('inbox').handler({ handle: 'rune' }));
  },

  async 'dm-sent'() {
    fixture({ users: [CAST.rune] });
    store.sendMessage = async () => ({ success: true, id: 'm_synthetic' });
    show('dm · sent while they are here', await fresh('dm').handler({ handle: 'rune', message: ASK }));
  },
  async 'dm-sent-away'() {
    fixture({ users: [runeAway] });
    store.sendMessage = async () => ({ success: true, id: 'm_synthetic' });
    show('dm · sent while they are away', await fresh('dm').handler({ handle: 'rune', message: ASK }));
  },
  async 'dm-transport-failed'() {
    // What the tool receives when the wire is down mid-request.
    fixture({ users: [] });
    store.sendMessage = async () => null;
    show('dm · transport failed (store returned a falsy result)', await fresh('dm').handler({ handle: 'rune', message: 'hello' }));
  },
  async 'dm-unknown'() {
    fixture({ users: [] });
    store.sendMessage = async () => ({ error: 'handle_not_found', message: "There's no @nosuchperson on /vibe. `vibe who` shows who's here." });
    show('dm · handle does not exist', await fresh('dm').handler({ handle: 'nosuchperson', message: 'hello' }));
  },
  async 'dm-expired'() {
    fixture({ users: [] });
    store.sendMessage = async () => ({ error: 'auth_expired', message: 'Your /vibe session expired. Run `vibe init` to reconnect.' });
    show('dm · session expired', await fresh('dm').handler({ handle: 'rune', message: 'hello' }));
  },

  async 'reply-sent'() {
    fixture({
      users: [CAST.ada],
      threads: [{ handle: 'ada', lastMessage: ASK, unread: 1, lastTimestamp: mins(9) }],
    });
    store.sendMessage = async () => ({ success: true, id: 'm_synthetic' });
    show('reply · answering the unread', await fresh('reply').handler({ message: ANSWER }));
  },
  async 'reply-transport-failed'() {
    fixture({
      users: [CAST.rune],
      threads: [{ handle: 'rune', lastMessage: THREAD[1].body, unread: 1, lastTimestamp: mins(4) }],
    });
    store.sendMessage = async () => null;
    show('reply · transport failed (store returned a falsy result)', await fresh('reply').handler({ message: 'hello' }));
  },
  async 'reply-caught-up'() {
    fixture({ users: [CAST.rune], threads: [{ handle: 'rune', lastMessage: 'thanks', unread: 0, lastTimestamp: mins(120) }] });
    show('reply · nothing unread', await fresh('reply').handler({ message: 'one more thing' }));
  },

  async status() {
    fixture({ users: [CAST.rune], unread: 1 });
    show('status · shipping', await fresh('status').handler({ mood: 'shipping' }));
  },
  async 'status-missing'() {
    fixture({ users: [] });
    show('status · called with no mood at all', await fresh('status').handler({}));
  },
  async 'status-unknown'() {
    fixture({ users: [] });
    show('status · unknown mood word', await fresh('status').handler({ mood: 'vibing' }));
  },

  async 'token-invalid'() {
    show('token · too short / garbage', await fresh('token').handler({ token: 'abc' }));
  },

  // The pending-message presentation: what the ambient footer appends to the
  // recipient's next tool response (index.js getPresenceFooter → renderIncoming).
  async 'footer-pending'() {
    const footer = `\n────────────────────────\nvibe · 1 other · **1 unread**` + renderIncoming(
      [{ from: ME === 'rune' ? 'ada' : 'rune', text: ME === 'rune' ? ASK : ANSWER }],
      { replyTo: ME === 'rune' ? 'ada' : 'rune', threadHint: true },
    );
    show('footer · a message waiting on your next turn', footer.trimStart());
  },

  // Rune's side of the thread: the question from ada is the unread.
  async 'inbox-rune'() {
    fixture({
      users: [CAST.ada],
      unread: 1,
      threads: [{ handle: 'ada', lastMessage: ASK, unread: 1, lastTimestamp: mins(9) }],
      thread: [{ from: 'ada', body: ASK, timestamp: mins(9), read: false }],
    });
    show('inbox · the question, on rune\'s next turn', await fresh('inbox').handler({}));
  },
};

// ── demo mode: the asynchronous two-person round trip, both terminals ───────

const BEATS = [
  ['note', 'BEAT 1 · clean install — `npx slashvibe-mcp` (or the one-line installer), then the coding agent restarts with the vibe tools registered. Nothing to configure.'],
  ['note', 'BEAT 2 · sign in — @ada says "let\'s vibe". `vibe_init` opens GitHub in the browser; her GitHub username becomes her @handle. (Browser OAuth — not renderable in this harness; the states below are all real renderer output.)'],
  ['ada',  'who-collaborator-away', 'BEAT 3 · @ada looks up — the collaborator she needs is away, and the agent is visibly an agent'],
  ['ada',  'dm-sent-away',   'BEAT 4 · @ada sends while @rune is away — the surface states the async model'],
  ['rune', 'footer-pending', 'BEAT 5 · @rune\'s next turn — the question arrives ambiently, framed as data'],
  ['rune', 'inbox-rune',     'BEAT 6 · @rune opens it — one unread sender, so the thread opens itself'],
  ['rune', 'reply-sent',     'BEAT 7 · @rune answers'],
  ['ada',  'footer-pending', 'BEAT 8 · the answer appears on @ada\'s next /vibe-aware turn — she never had to leave what she was doing'],
  ['ada',  'inbox-waiting',  'BEAT 9 · @ada reads the full answer and unblocks the rollback fixture'],
];

async function demo() {
  console.log('# /vibe demo transcript — one asynchronous round trip');
  console.log('');
  console.log('Synthetic cast (@ada, @rune, @juno, @atlas 🤖) and a synthetic decision;');
  console.log('no real handles or messages. Every block below is the actual text the');
  console.log('kernel renderers produce for that state.');
  console.log('');
  console.log('Regenerate: `node scripts/render-states.mjs demo > docs/DEMO-TRANSCRIPT.md`');
  for (const [who, state, caption] of BEATS) {
    if (who === 'note') { console.log(`\n> ${state}`); continue; }
    console.log(`\n> ${caption}`);
    console.log(`> _(@${who}'s terminal)_`);
    console.log('\n```text');
    const out = execFileSync(process.execPath, [SELF, state], {
      env: { ...process.env, VIBE_AS: who }, encoding: 'utf8',
    });
    console.log(out.replace(/^\n*/, '').replace(/^─+\n▌ [^\n]*\n─+\n/, '').trimEnd());
    console.log('```');
  }
  console.log('');
}

const which = process.argv[2] || 'all';
if (which === 'demo') {
  await demo();
} else {
  const run = which === 'all' ? Object.keys(STATES) : [which];
  for (const k of run) {
    if (!STATES[k]) { console.error(`unknown state: ${k}\n  ${Object.keys(STATES).join(' · ')}`); process.exit(2); }
    try { await STATES[k](); } catch (e) { show(`${k} · THREW`, String(e.stack || e)); }
  }
}
fs.rmSync(HOME, { recursive: true, force: true });
