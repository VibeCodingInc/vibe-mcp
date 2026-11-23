'use strict';
/**
 * The invited person's first minute (audit 2026-11-22, invite-first-minute).
 *
 * Against the lab stand-in API on 127.0.0.1 (lab/stub.mjs), which now models
 * a code that carries a first message: delivered once, as an ordinary message
 * from the inviter, by the sign-in that redeems that code, and by nothing else
 * (api/lib/invite-redemption.js, invite-thought.js).
 *
 *   heldCarriesCode    a Keep's pass-on command carries the held message's
 *                      code; the old command without it delivered nothing.
 *   inviteQuestion     vibe_prepare {invite: true}: one message on a new
 *                      invite line, the same preview, turn check and box as
 *                      a Keep, delivered once to whoever joins with the line.
 *   invitedEmptyState  the first session names the inviter while nothing has
 *                      passed between them; "Rare moment" only with a
 *                      conversation; an agent is not "a person waiting".
 *   setupReceipt       the installer's last screen for someone invited.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-first-minute-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ handle: 'ada', token: jwt('ada'), provider: 'github', authenticated_at: new Date().toISOString() }));

let stub; let moves; let invite; let confirmBox; let setup;
test.before(async () => {
  stub = await (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people: { ada: {}, nell: {}, mo: {}, coltrane: { kind: 'agent' } } });
  // store/api.js reads the API address once, when it is first loaded.
  process.env.VIBE_API_URL = stub.url;
  moves = require('./drafts');
  invite = require('../invite');
  confirmBox = require('../confirm-box');
  setup = require('../setup');
});
test.after(async () => { await stub.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

const inbox = (h) => stub.messages.filter((m) => m.to === h);
/** What B's sign-in does with the command A passed on: the code it carries, redeemed; nothing without one. */
function signInWith(command, handle) {
  const code = invite.inviteArg(command.split(' '));
  return code ? stub.redeem(code, handle) : false;
}
function withOff(name, fn) {
  const was = process.env.VIBE_NOTICE_OFF;
  process.env.VIBE_NOTICE_OFF = name;
  return Promise.resolve().then(fn).finally(() => { if (was === undefined) delete process.env.VIBE_NOTICE_OFF; else process.env.VIBE_NOTICE_OFF = was; });
}

// ── JOB 1: the held message's command carries its code ─────────────────────

test('heldCarriesCode: the command comes first and carries the code; B signing in with it gets the message', async () => {
  const text = 'the pooler goes back to session mode tonight; does your worker reconnect on its own?';
  const d = await moves.vibe_prepare.handler({ handle: 'dalia', message: text, asked: true });
  assert.equal(d.data.draft.held, true);
  const r = await moves.vibe_send.handler({ id: d.data.draft.id, rev: d.data.draft.rev });
  assert.equal(r.data.held, true, r.display);
  const code = [...stub.invites.values()].find((i) => i.named_for === 'dalia').code;
  assert.match(code, /^VIBE-[A-Z0-9]{10}-ADA$/, 'the platform\'s current code shape is accepted');
  const lines = r.display.split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    'Held for @dalia. /vibe created the invitation.',
    `**Pass on to them:** npx slashvibe-mcp setup --from @ada --invite ${code}`,
    `**Or the page:** https://www.slashvibe.dev/join?from=ada&invite=${code}`,
  ]);
  assert.match(lines[3], /^Your message is kept for the GitHub account dalia for 30 days, until \d{4}-\d{2}-\d{2}\. It arrives as your first message when they join \/vibe with that account through this command or page\. A sign-in without the code does not carry it, and nothing reaches them before then\.$/);
  assert.equal(r.data.pass_on, `npx slashvibe-mcp setup --from @ada --invite ${code}`);
  assert.doesNotMatch(r.display, /!/);

  // The bug, kept as a regression: the command A was given before (no code).
  const old = invite.line('ada').command;
  assert.equal(old, 'npx slashvibe-mcp setup --from @ada');
  assert.equal(signInWith(old, 'dalia'), false, 'a sign-in without the code redeems nothing');
  assert.equal(inbox('dalia').length, 0, 'so the held message is never delivered');
  // Someone else cannot take it with the code: it is named for dalia.
  assert.equal(stub.redeem(code, 'mo'), false);
  assert.equal(inbox('mo').length, 0);
  // The command A is shown now delivers it, once.
  assert.equal(signInWith(r.data.pass_on, 'dalia'), true);
  assert.deepEqual(inbox('dalia').map((m) => [m.from, m.body]), [['ada', text]]);
  assert.equal(signInWith(r.data.pass_on, 'dalia'), false, 'once');
  assert.equal(inbox('dalia').length, 1);
});

test('heldCarriesCode: a code the join page would drop cannot ride in a command, and the line says only the link delivers it', () => {
  // The join page (api/join/index.js INVITE_CODE_RE, the same shape as
  // invite.validCode) drops a code with "_" in it, which an inviter whose
  // handle starts "a_b" gets; a command built with it would carry nothing.
  assert.equal(invite.line('a_bc', 'VIBE-ABCDEFGHJK-A_BC').command, 'npx slashvibe-mcp setup --from @a_bc');
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'drafts.js'), 'utf8');
  assert.match(src, /It arrives only if they sign in to \/vibe with that account through this link: a setup command from here cannot carry its code\./);
});

test('heldCarriesCode switched off (loopback only): the earlier lines, and the earlier 4-character code check', async () => {
  await withOff('heldCarriesCode', async () => {
    const d = await moves.vibe_prepare.handler({ handle: 'olde', message: 'kept the old way', asked: true });
    const r = await moves.vibe_send.handler({ id: d.data.draft.id, rev: d.data.draft.rev });
    // The stand-in answers with today's 10-character code, which the old check
    // did not accept: this is the earlier behaviour, unconfirmed.
    assert.match(r.display, /^\/vibe answered, but not with an invitation held for this account/);
  });
});

// ── JOB 2: a message on a new invite line ───────────────────────────────────

const QUESTION = 'Did the staging key rotate on Friday, or is the old one still live?';

test('inviteQuestion: the preview names no one, says who gets it and that it is shown to whoever uses the line; nothing is created', async () => {
  const before = stub.invites.size;
  const lookups = stub.effects.filter((e) => e.effect === 'read_identity').length;
  const p = await moves.vibe_prepare.handler({ invite: true, message: QUESTION, asked: true });
  assert.equal(p.data.draft.invite, true);
  assert.equal(p.data.draft.to, null);
  assert.equal(p.display, [
    '**On:** a new invite line (for whoever joins /vibe with it, once)',
    '**Message (exact):**',
    QUESTION,
    '**Attachments:** none',
    '',
    'If you keep it, /vibe makes a new invite line that carries this exact message, kept for 30 days. The first person who joins /vibe with that line gets it once, as your first message to them, and the line is then used up. Anyone you pass the line to could be that person, so leave out anything you would not send them. You get the command and page to pass on; nothing reaches anyone before they join. Once made, the line cannot be taken back from here; it stops working when it is used or after 30 days.',
    '',
    `Keep on a new invite line · Edit · Cancel — nothing has been sent.  _(draft ${p.data.draft.id} · rev ${p.data.draft.rev})_`,
    "This app cannot show /vibe's confirmation box or record your reply; a message goes when the agent sends it after you say so.",
  ].join('\n'));
  assert.equal(p.data.actions[0].label, 'Keep on a new invite line');
  assert.equal(stub.invites.size, before, 'preparing creates nothing');
  assert.equal(stub.effects.filter((e) => e.effect === 'read_identity').length, lookups, 'nobody is looked up');
});

test('inviteQuestion: Keep makes one unnamed invitation carrying exactly the approved text; the line comes command first; whoever joins with it gets it once', async () => {
  const p = await moves.vibe_prepare.handler({ invite: true, message: QUESTION, asked: true });
  const sends = stub.effects.filter((e) => e.effect === 'HELD').length;
  const r = await moves.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(r.data.held, true, r.display);
  assert.equal(r.data.invite_line, true);
  const held = stub.effects.filter((e) => e.effect === 'HELD');
  assert.equal(held.length, sends + 1);
  assert.equal(held.at(-1).body, QUESTION);
  assert.equal(held.at(-1).for_github, null, 'named for nobody');
  const code = held.at(-1).code;
  assert.deepEqual(r.display.split('\n'), [
    'Kept on a new invite line. /vibe created the invitation.',
    `**Pass on:** npx slashvibe-mcp setup --from @ada --invite ${code}`,
    `**Or the page:** https://www.slashvibe.dev/join?from=ada&invite=${code}`,
    r.display.split('\n')[3],
  ]);
  assert.match(r.display.split('\n')[3], /^The first person to join \/vibe with this line gets your message once, as your first message to them; nothing reaches anyone before then\. The line works for 30 days, until \d{4}-\d{2}-\d{2}\.$/);
  assert.doesNotMatch(r.display, /!/);
  // Kept again: no second invitation.
  const again = await moves.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(again.display, `Draft ${p.data.draft.id} is already on an invite line — not creating a second one. Pass on: npx slashvibe-mcp setup --from @ada --invite ${code}`);
  // The plain line never reuses a code that carries a message (invite.codeFor).
  const plain = await invite.codeFor('ada');
  assert.ok(plain, 'a plain code is there to give out');
  assert.notEqual(plain, code);
  // Nell joins with it: the question is hers, once, from @ada.
  assert.equal(signInWith(r.data.pass_on, 'nell'), true);
  assert.deepEqual(inbox('nell').map((m) => [m.from, m.body]), [['ada', QUESTION]]);
  assert.equal(stub.redeem(code, 'mo'), false, 'one line, one person');
  assert.equal(inbox('mo').length, 0);
});

test('inviteQuestion: what it refuses, before anything is drafted', async () => {
  const no = async (args, re) => { const r = await moves.vibe_prepare.handler(args); assert.match(r.display, re); assert.ok(!r.data || !r.data.draft); };
  await no({ invite: true, handle: 'nell', message: 'hi' }, /^Not prepared: a message on an invite line is for whoever joins with the line, so it takes no handle\./);
  await no({ invite: true, message: 'hi', reply_to: 'msg_1' }, /^Not prepared: a message on an invite line answers no message yet/);
  await no({ invite: true, message: 'hi', kind: 'landed' }, /^Not prepared: a note back \("landed"\) needs reply_to/);
  await no({ invite: true }, /^To put a message on an invite line: pass invite: true and the message\./);
  await no({ invite: true, message: 'x'.repeat(2001) }, /^Not ready — the message is 2001 chars and the limit is 2000/);
  await no({ invite: true, message: 'look​here' }, /^Not prepared: the message contains a character that does not show/);
  // An ordinary draft cannot be turned into one.
  const o = await moves.vibe_prepare.handler({ handle: 'nell', message: 'plain one', asked: true });
  const e = await moves.vibe_prepare.handler({ id: o.data.draft.id, invite: true, message: 'now on a line' });
  assert.match(e.display, /^Not changed: draft w[0-9a-f]+ is a message to @nell; a message on an invite line is opened as a new draft/);
});

test('inviteQuestion: an agent account cannot make an invite line with a message; a held message to a named account is unchanged', async () => {
  const agentAuth = require('../agent-auth');
  const was = agentAuth.signedInAsAgent;
  agentAuth.signedInAsAgent = () => true;
  try {
    const before = stub.invites.size;
    const r = await moves.vibe_prepare.handler({ invite: true, message: QUESTION, asked: true });
    assert.equal(r.display, 'Not prepared: an invite line with a message is made by a person; an agent account cannot make one. Nothing was sent.');
    assert.ok(!r.data || !r.data.draft, 'nothing drafted');
    assert.equal(stub.invites.size, before, 'nothing created');
    // A message held for a named account is still prepared, as before.
    const h = await moves.vibe_prepare.handler({ handle: 'agentheld', message: 'the cron moved to 02:00 UTC', asked: true });
    assert.equal(h.data.draft.held, true, h.display);
    assert.equal(h.data.draft.to, 'agentheld');
    assert.match(h.display, /^\*\*To:\*\* @agentheld \(not on \/vibe yet\)/);
  } finally { agentAuth.signedInAsAgent = was; }
  // Signed in as a person: offered as before.
  const p = await moves.vibe_prepare.handler({ invite: true, message: QUESTION, asked: true });
  assert.equal(p.data.draft.invite, true);
});

test('inviteQuestion: no "@null" for an invite draft in discard, edit or send refusals', async () => {
  const p = await moves.vibe_prepare.handler({ invite: true, message: 'which branch is the release cut from?', asked: true });
  const id = p.data.draft.id;
  const setState = (patch) => moves.transact((all) => { const d = all.find((x) => x.id === id); for (const k of Object.keys(d)) if (['status', 'unconfirmed', 'claimedAt', 'claimedBy'].includes(k)) delete d[k]; Object.assign(d, patch); });
  const texts = [];
  const look = (t, re) => { texts.push(t); assert.match(t, re); assert.doesNotMatch(t, /@null|@undefined/); };
  // Discard while it is being sent.
  await setState({ status: 'sending', claimedAt: Date.now(), claimedBy: process.pid });
  look((await moves.vibe_discard.handler({ id })).display, new RegExp(`^Draft ${id} is being sent to your invite line right now`));
  // Discard of a cancelled draft whose earlier Send did not confirm.
  await setState({ status: 'cancelled', unconfirmed: true });
  look((await moves.vibe_discard.handler({ id })).display, new RegExp(`^Draft ${id} is already cancelled — and the earlier Send to your invite line did not confirm`));
  // Editing a cancelled-after-unconfirmed draft, and a sent one.
  look((await moves.vibe_prepare.handler({ id, message: 'changed' })).display, new RegExp(`^Draft ${id} was cancelled after a Send to your invite line that did not confirm`));
  await setState({ status: 'sent' });
  look((await moves.vibe_prepare.handler({ id, message: 'changed' })).display, new RegExp(`^Draft ${id} was already sent to your invite line — nothing changed`));
  // Discard and Send of a sent one.
  look((await moves.vibe_discard.handler({ id })).display, new RegExp(`^Draft ${id} was already sent to your invite line — a sent message can't be unsent`));
  look((await moves.vibe_send.handler({ id, rev: p.data.draft.rev })).display, new RegExp(`Draft ${id} was already sent to your invite line — not sending it twice`));
  assert.equal(texts.length, 6);
  await setState({ status: 'cancelled' });
});

test('invitedEmptyState: --from is recorded as the inviter only when the --invite code is consistent with it (the platform\'s suffix rule)', async () => {
  // The shape api/lib/invite-code.js mints for @ada (not minted on the stand-in: its three-code allowance is used by the tests below).
  const minted = 'VIBE-ABCDEFGHJK-ADA';
  assert.equal(invite.codeIsFrom(minted, 'ada'), true);
  assert.equal(invite.codeIsFrom('VIBE-ABCDEFGHJK-MALL', 'mallory'), true, 'the first four letters, upper-cased');
  assert.equal(invite.codeIsFrom('VIBE-ABCDEFGHJK-ADA', 'mallory'), false);
  assert.equal(invite.codeIsFrom('VIBE-ABCDEFGHJK-ADA', 'adam'), false, 'ADAM, not ADA');
  assert.equal(invite.codeIsFrom('VIBE-ABCDEFGHJK-A-B', 'a-b'), true);
  assert.equal(invite.codeIsFrom('VIBE-ADA', 'ada'), false, 'no random part');
  const fetchFor = (handle) => async () => ({ ok: true, status: 200, json: async () => ({ handle, kind: 'human' }) });
  // A matching pair: recorded, and named at session start.
  const vhOk = homeFor('tess');
  const ok = await invite.accept('@ada', 'tess', { code: minted, env: { VIBE_HOME: vhOk }, fetchImpl: fetchFor('ada'), apiUrl: 'http://127.0.0.1:9' });
  assert.equal(ok.known, true);
  assert.equal(invite.inviter({ VIBE_HOME: vhOk }), 'ada');
  assert.ok((await sitDown(vhOk)).lines.some((l) => /@ada invited you/.test(l)));
  // A forwarded line: --from @mallory with ada's code. Nothing recorded, no "invited you" line.
  const vhNo = homeFor('ursa');
  const no = await invite.accept('@mallory', 'ursa', { code: minted, env: { VIBE_HOME: vhNo }, fetchImpl: fetchFor('mallory'), apiUrl: 'http://127.0.0.1:9' });
  assert.equal(no.known, false);
  assert.deepEqual(no.lines, ['That invite code was not made by @mallory, so nobody was marked as your inviter.']);
  assert.ok(!no.lines.some((l) => /invited you/.test(l)));
  assert.equal(invite.inviter({ VIBE_HOME: vhNo }), null, 'no inviter recorded');
  assert.equal(require('../reach').isKnown('mallory', { VIBE_HOME: vhNo }), false, 'not marked known either');
  const s = await sitDown(vhNo);
  assert.ok(!s.lines.some((l) => /invited you/.test(l)), s.lines.join('\n'));
  // No code (an older line): --from alone is recorded, as before.
  const vhPlain = homeFor('vera');
  assert.equal((await invite.accept('@mallory', 'vera', { env: { VIBE_HOME: vhPlain }, fetchImpl: fetchFor('mallory'), apiUrl: 'http://127.0.0.1:9' })).known, true);
  assert.equal(invite.inviter({ VIBE_HOME: vhPlain }), 'mallory');
  // setup.js passes the --invite code through.
  assert.match(fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8'), /invite\.accept\(from, authResult\.handle, \{ code: invite\.inviteArg\(\) \}\)/);
});

test('inviteQuestion: the box asks for the first letters of "invite", three or more; no reply word, no "@", no handle', () => {
  const ok = (v) => confirmBox.typedOk(null, v, { invite: true });
  for (const v of ['inv', 'invi', 'invit', 'invite', 'INV', ' Invite ']) assert.equal(ok(v), true, v);
  for (const v of ['', 'i', 'in', '@inv', 'invites', 'inx', 'yes', 'send', 'nell', 'ne']) assert.equal(ok(v), false, v);
  for (const w of confirmBox.REPLY_WORDS) assert.equal(ok(w), false, w);
  const f = confirmBox.fieldText(null, { invite: true });
  assert.equal(f.title, 'Type "inv" to make the invite line');
  assert.ok(f.title.length <= confirmBox.TITLE_MAX);
  assert.equal(f.description, 'The first letters of the word "invite". Enter alone will not send; Esc cancels.');
  assert.equal(confirmBox.question({ invite: true, held: true, text: 'short one' }), 'Confirm: put this on a new invite line? (9 chars, all shown)');
  assert.equal(confirmBox.answerOf({ action: 'accept', content: { to: 'inv' } }, null, { invite: true }), 'accept');
  assert.equal(confirmBox.answerOf({ action: 'accept', content: { to: 'in' } }, null, { invite: true }), 'wrong');
  // An ordinary box is unchanged by the option's existence.
  assert.equal(confirmBox.typedOk('nell', 'nel'), true);
  assert.equal(confirmBox.typedOk('invite', 'in'), true, 'a real @invite handle keeps the handle rule');
});

test('inviteQuestion switched off (loopback only): the field is not offered or read', async () => {
  await withOff('inviteQuestion', async () => {
    assert.ok(!('invite' in moves.vibe_prepare.definition.inputSchema.properties));
    assert.doesNotMatch(moves.vibe_prepare.definition.description, /invite: true/);
    const r = await moves.vibe_prepare.handler({ invite: true, message: QUESTION });
    assert.equal(r.display, 'To prepare a message: pass a handle and a message (or a draft id to edit). Nothing is sent by this step.');
  });
  assert.equal(moves.vibe_prepare.definition.inputSchema.properties.invite.type, 'boolean');
  assert.match(moves.vibe_prepare.definition.description, /pass invite: true and the message, with no handle/);
});

test('inviteQuestion end to end through the server: typed turn, stateless box, a wrong word is not accepted, "inv" keeps it', async () => {
  const turns = require('../turns');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-fm-box-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-fm-box-p-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ handle: 'ada', token: jwt('ada'), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ handle: 'ada', one_liner: 'me' }));
  turns.record(project, Date.now() - 60_000, { VIBE_HOME: home });
  const env = { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: stub.url, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: home };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'VIBE_AGENT_HANDLE', 'VIBE_TURNS_DIR', 'VIBE_NOTICE_OFF']) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], { env, cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
  const rows = []; let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { rows.push(JSON.parse(l)); } catch {} } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const wait = (id) => new Promise((resolve, reject) => { const t0 = Date.now(); const f = () => { const r = rows.find((x) => x.id === id); if (r) return resolve(r); if (Date.now() - t0 > 15_000) return reject(new Error(`no response ${id}`)); setTimeout(f, 20); }; f(); });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: 'test' } };
  const call = (id, name, args, extra = {}) => send({ id, method: 'tools/call', params: { name, arguments: args, _meta: meta, ...extra } });
  const text = 'Is the replay window on the webhook signer 5 minutes or 10?';
  try {
    call(1, 'vibe_prepare', { invite: true, message: text, asked: true });
    const prep = (await wait(1)).result.content[0].text;
    assert.match(prep, /^\*\*On:\*\* a new invite line/);
    const id = prep.match(/draft (w[0-9a-f]+)/)[1]; const rev = prep.match(/rev ([0-9a-f]{8})/)[1];
    // Shown and sent in one turn: refused, nothing made.
    call(2, 'vibe_send', { id, rev });
    const early = (await wait(2)).result.content[0].text;
    assert.match(early, /^Not sent yet: they have not typed a message since it was shown/);
    // The person types "send"; the box opens and names what is happening.
    await new Promise((r) => setTimeout(r, 5));
    turns.record(project, Date.now(), { VIBE_HOME: home });
    call(3, 'vibe_send', { id, rev });
    const box = (await wait(3)).result;
    assert.equal(box.resultType, 'input_required');
    const params = box.inputRequests.send_confirmation.params;
    assert.match(params.message, /^Confirm: put this on a new invite line\? \(59 chars, all shown\)\n> Is the replay window/);
    assert.equal(params.requestedSchema.properties.to.title, 'Type "inv" to make the invite line');
    // "in" is not enough: not accepted, nothing made.
    call(4, 'vibe_send', { id, rev }, { inputResponses: { send_confirmation: { action: 'accept', content: { to: 'in' } } }, requestState: box.requestState });
    const no = (await wait(4)).result.content[0].text;
    assert.equal(no, 'Not sent. It is still a draft for your invite line. Only if they ask again: show it with vibe_prepare and wait for them to say send.');
    assert.ok(!stub.effects.some((e) => e.effect === 'HELD' && e.body === text));
    // Shown again, a new turn, a new box, "inv": kept.
    call(5, 'vibe_prepare', { id });
    await wait(5);
    await new Promise((r) => setTimeout(r, 5));
    turns.record(project, Date.now(), { VIBE_HOME: home });
    call(6, 'vibe_send', { id, rev });
    const box2 = (await wait(6)).result;
    assert.equal(box2.resultType, 'input_required');
    call(7, 'vibe_send', { id, rev }, { inputResponses: { send_confirmation: { action: 'accept', content: { to: 'inv' } } }, requestState: box2.requestState });
    const done = (await wait(7)).result.content[0].text;
    assert.match(done, /^Kept on a new invite line\. \/vibe created the invitation\.\n\*\*Pass on:\*\* npx slashvibe-mcp setup --from @ada --invite VIBE-/);
    assert.equal(stub.effects.filter((e) => e.effect === 'HELD' && e.body === text).length, 1);
  } finally { child.kill(); for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true }); }
});

// ── B's first session (JOB 2 arrival, JOB 3 empty state) ────────────────────

function homeFor(handle, { known = [], inviter = null } = {}) {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-fm-b-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(known.map((h) => [h, 1])) }));
  if (inviter) invite.noteInviter(inviter, { VIBE_HOME: vh });
  return vh;
}
function sitDown(vh, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'session-start-hook.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: stub.url, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '', ...extra },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); const o = JSON.parse(out || '{}'); resolve({ lines: String(o.systemMessage || '').split('\n').filter((l) => l && !/here now:/.test(l)), context: (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '' }); });
  });
}

test('B\'s first session: the question on the invite line arrives as an ordinary note from @ada, with the ordinary arrival text', async () => {
  const code = stub.mintCode('ada');
  stub.invites.get(code).first_thought = 'Which region did you pin the staging bucket to?';
  assert.equal(stub.redeem(code, 'pia'), true);
  // setup --from @ada marked her known and recorded her as the inviter (invite.accept).
  const s = await sitDown(homeFor('pia', { known: ['ada'], inviter: 'ada' }));
  assert.equal(s.lines.length, 1, s.lines.join('\n'));
  assert.match(s.lines[0], /^\/vibe · Note from @ada \((just now|\dm ago)\): Which region did you pin the staging bucket to\?$/);
  assert.match(s.context, /^\/vibe waiting messages\./m);
  assert.doesNotMatch(s.lines.join('\n'), /invited you|Rare moment/);
});

test('invitedEmptyState: invited, nothing from them yet: one line naming the inviter and what to say; never "Rare moment" on day one', async () => {
  const vh = homeFor('quin', { known: ['ada'], inviter: 'ada' });
  const first = await sitDown(vh);
  assert.deepEqual(first.lines, ['/vibe · @ada invited you. Nothing from them yet. To write first, say: message @ada: …']);
  assert.match(first.context, /@ada invited the person to \/vibe, and nothing has passed between them yet\. The person has been shown this line\. Do not open a draft to @ada on your own now/);
  assert.ok(!fs.existsSync(path.join(vh, 'nothing-waiting.json')), 'no wry line was given');
  // Switched off (loopback only): no inviter line, and the wry line on day one, as before.
  const off = await sitDown(homeFor('quin', { known: ['ada'], inviter: 'ada' }), { VIBE_NOTICE_OFF: 'invitedEmptyState' });
  assert.deepEqual(off.lines, ['/vibe · Nothing waiting. Rare moment — enjoy it.']);
  // Once she has written: her note, not the inviter line.
  stub.post('ada', 'quin', 'made it? the retry queue is yours now');
  const second = await sitDown(vh);
  assert.equal(second.lines.length, 1);
  assert.match(second.lines[0], /^\/vibe · Note from @ada /);
  // Once he has answered (a conversation, nothing unread from her): no inviter line; the wry line may come.
  stub.post('quin', 'ada', 'in. which backoff did you land on?');
  const third = await sitDown(vh);
  assert.deepEqual(third.lines, ['/vibe · Nothing waiting. Rare moment — enjoy it.']);
  // A list that could not be read says nothing about the inviter.
  const down = await sitDown(homeFor('quin', { known: ['ada'], inviter: 'ada' }), { VIBE_API_URL: 'http://127.0.0.1:9', VIBE_SESSION_START_DEADLINE_MS: '1500' });
  assert.deepEqual(down.lines, []);
});

test('invitedEmptyState: a muted inviter, or none recorded, is not named; the record lasts 30 days', async () => {
  const vh = homeFor('rae', { known: ['ada'], inviter: 'ada' });
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: { ada: 1 }, known: { ada: 1 } }));
  assert.deepEqual((await sitDown(vh)).lines, []);
  assert.deepEqual((await sitDown(homeFor('rae', { known: ['ada'] }))).lines, []);
  const env = { VIBE_HOME: homeFor('rae') };
  invite.noteInviter('ada', env, 1000);
  assert.equal(invite.inviter(env, 1000 + invite.INVITER_TTL_MS), 'ada');
  assert.equal(invite.inviter(env, 1001 + invite.INVITER_TTL_MS), null);
  invite.noteInviter('not a handle!', env);
  assert.equal(invite.inviter(env, 1000), 'ada', 'a malformed handle is never recorded');
});

test('invitedEmptyState: an agent\'s welcome is not "a person you have not written to"; a person still is', async () => {
  stub.post('coltrane', 'sol', 'Welcome to /vibe. Run: claude mcp add vibe');
  const s = await sitDown(homeFor('sol'));
  assert.deepEqual(s.lines, [], s.lines.join('\n'));
  const off = await sitDown(homeFor('sol'), { VIBE_NOTICE_OFF: 'invitedEmptyState' });
  assert.deepEqual(off.lines, ["/vibe · 1 person you have not written to is waiting. Say: what's waiting on /vibe"]);
  stub.post('mo', 'sol', 'hey, saw your PR');
  const both = await sitDown(homeFor('sol'));
  assert.deepEqual(both.lines, ["/vibe · 1 person you have not written to is waiting. Say: what's waiting on /vibe"]);
});

// ── JOB 4: the installer's last screen for someone invited ──────────────────

test('setupReceipt: invited, the inviter comes first and the note waiting next; "Open a fresh Claude Code session" stays last', () => {
  const inviteLines = ['@ada invited you, so what they write reaches you while you work.', 'Nothing was sent and no line was opened. Undo: npx slashvibe-mcp mute @ada'];
  assert.deepEqual(setup.finalLines({ waiting: { total: 1, named: ['ada'], others: 0 }, inviteLines, invited: true }), [
    { text: '@ada invited you, so what they write reaches you while you work.', strong: true },
    { text: 'Nothing was sent and no line was opened. Undo: npx slashvibe-mcp mute @ada', strong: false },
    { text: '1 note waiting from @ada.', strong: true },
    { text: 'Open a fresh Claude Code session to load /vibe. Sessions that are already open will not see it.', strong: true },
  ]);
  assert.deepEqual(setup.finalLines({ waiting: null, inviteLines, invited: true }).map((l) => l.text).at(-1), 'Open a fresh Claude Code session to load /vibe. Sessions that are already open will not see it.');
  // Not invited: exactly as before.
  assert.deepEqual(setup.finalLines({ waiting: { total: 2, named: [], others: 2 } }), [
    { text: '2 notes waiting, from 2 people you have not written to.', strong: true },
    { text: 'Open a fresh Claude Code session to load /vibe. Sessions that are already open will not see it.', strong: true },
  ]);
  // The "takes two" block (and the code it would spend) is left out for someone who came with --from.
  const src = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
  assert.match(src, /const invitedHere = receipt && Boolean\(from\);\n\s+const bring = invitedHere \? null : invite\.line\(authResult\.handle, await invite\.codeFor\(authResult\.handle\)\);/);
});
