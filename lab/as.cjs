#!/usr/bin/env node
// Act as one identity, against whatever API its home points at. For checks.
//   node lab/as.cjs <vibe-home> send <to> <message> [reply_to]   prepare + approved send (the draft path)
//   node lab/as.cjs <vibe-home> thread <with> [n]                 read the last n messages (does NOT mark read)
//   node lab/as.cjs <vibe-home> unread <with>                     unread count in that conversation
const [home, cmd, a, b, c] = process.argv.slice(2);
process.env.VIBE_HOME = home;
const err = console.error; console.error = () => {}; console.log = ((l) => (...x) => l(...x))(console.log);
(async () => {
  const authStore = require('../auth-store'); authStore.hydrate();
  const store = require('../store'); const me = authStore.getHandle();
  if (cmd === 'send') {
    const drafts = require('../tools/drafts');
    const p = await drafts.vibe_prepare.handler({ handle: a, message: b, reply_to: c || undefined, project: 'lab check' });
    if (!p.data) { process.stdout.write(JSON.stringify({ me, error: p.display }) + '\n'); process.exit(1); }
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    process.stdout.write(JSON.stringify({ me, sent: r.data && r.data.sent, id: r.data && r.data.message_id, display: r.display }) + '\n');
  } else if (cmd === 'thread') {
    const t = await store.getThread(me, a);
    process.stdout.write(JSON.stringify(t.slice(-(Number(b) || 6)).map((m) => ({ id: m.id, from: m.from, reply_to: m.reply_to ? m.reply_to.id : null, body: m.body }))) + '\n');
  } else if (cmd === 'unread') {
    const i = await store.getInboxResult(me); const t = (i.threads || []).find((x) => x.handle === a);
    process.stdout.write(JSON.stringify({ me, ok: i.ok, unread: t ? t.unread : null, lastFrom: t ? t.lastFrom : null, lastId: t ? t.lastMessageId : null }) + '\n');
  }
  process.exit(0);
})().catch((e) => { err(e); process.exit(1); });
