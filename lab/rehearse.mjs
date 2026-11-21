#!/usr/bin/env node
// Rehearse /vibe with REAL Claude Code sessions as lab identities, against the
// in-process stub (lab/stub.mjs). Nothing here touches production, a real
// account, or a real person:
//   - every session's /vibe server gets VIBE_API_URL = the stub on 127.0.0.1,
//     its own VIBE_HOME under a temp dir, and CI=1 so sign-in can never open a
//     browser;
//   - the arrival hook is installed into a scratch settings file passed with
//     --settings, never into ~/.claude/settings.json.
//
//   node lab/rehearse.mjs            list scenarios
//   node lab/rehearse.mjs <name>     run one, print a report (exit 1 if a check fails)
//   node lab/rehearse.mjs all
//
// It costs real model tokens and takes a minute or two per scenario.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './stub.mjs';
import { scenarios } from './scenarios.mjs';
import { identity, cli, session, sleep } from './harness.mjs';

async function run(name) {
  const sc = scenarios[name];
  if (!sc) throw new Error(`no scenario "${name}"`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-lab-${name}-`));
  // Agent identities get a credential the stub knows, as the platform host would.
  const agentMints = Object.fromEntries(Object.entries(sc.people).filter(([, p]) => p.agent).map(([h]) => [h, `lab-mint-${h}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`]));
  const stub = await startStub({ people: sc.people, agentMints });
  const ids = {};
  for (const [h, p] of Object.entries(sc.people)) {
    ids[h] = identity(root, h, p.says, stub.url, p.trusts || [], p.knows || [], { muted: p.muted || [], invisible: Boolean(p.invisible), startHook: Boolean(sc.startHook), agentMint: agentMints[h] || null, serverEnv: p.serverEnv || {} });
    for (const [file, text] of Object.entries(p.files || {})) fs.writeFileSync(path.join(ids[h].work, file), text);
  }
  const lab = { stub, ids, sleep, agentMints, cli: (h, args, extraEnv) => cli(ids[h], args, extraEnv), session: (h, prompt, o) => session(ids[h], prompt, o), read: (h, f) => fs.readFileSync(path.join(ids[h].work, f), 'utf8') };
  const started = Date.now();
  let result; let failed = [];
  try {
    result = await sc.run(lab);
    failed = (sc.checks(result, lab) || []).filter((c) => !c.ok);
    const sends = stub.effects.filter((e) => e.effect === 'SEND');
    console.log(`\n# ${name}: ${sc.title}\n`);
    for (const c of result.terminal || []) console.log(`$ ${c.typed}\n${(c.out + c.err).trimEnd()}\n[exit ${c.code}]\n`);
    for (const [who, t] of Object.entries(result.sessions || {})) {
      console.log(`## @${who}'s session`);
      for (const s of t.shown) console.log(`shown to the person: ${s}`);
      for (const c of t.tools) console.log(`tool: ${c.name} ${JSON.stringify(c.input).slice(0, 700)}`);
      for (const r of t.returned) console.log(`\n/vibe printed:\n${r}`);
      console.log(`\nfinal message:\n${t.final}\n`);
    }
    console.log('## the wire');
    for (const s of sends) console.log(`SEND @${s.me} → @${s.to}${s.reply_to ? ` (answers ${s.reply_to}${s.linked ? '' : ', NOT LINKED'})` : ''} [${s.origin || 'composed'}${s.approved ? ', approved digest' : ''}]: ${s.body}`);
    console.log(`read-cursor writes: ${stub.effects.filter((e) => e.effect === 'READ_CURSOR').length}`);
    console.log(`\n## checks (${Math.round((Date.now() - started) / 1000)}s)`);
    for (const c of sc.checks(result, lab)) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.what}`);
  } finally {
    await stub.close();
    if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept: ${root}`);
  }
  return failed.length === 0;
}

const which = process.argv[2];
if (!which) {
  for (const [k, v] of Object.entries(scenarios)) console.log(`${k.padEnd(12)} ${v.title}`);
} else {
  const names = which === 'all' ? Object.keys(scenarios) : [which];
  let ok = true;
  for (const n of names) ok = (await run(n)) && ok;
  process.exit(ok ? 0 : 1);
}
