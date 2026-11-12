#!/usr/bin/env node
// Sign a LAB identity into an isolated /vibe home, for production rehearsals.
//
//   node lab/signin.cjs [--home <dir>] [--expect <handle>] [--no-open]
//
// Starts the normal GitHub sign-in against production, opens the login page in
// a private Chrome window (so GitHub is not already signed in as you), waits
// up to five minutes, and says who signed in. It refuses to run against the
// machine's real ~/.vibe, and if the account that signs in is not the one
// expected it deletes what it just saved.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : fallback; };
const home = path.resolve(arg('--home', path.join(os.homedir(), '.vibe-lab-home', '.vibe')));
const expect = String(arg('--expect', 'vibetester1')).toLowerCase();
if (home === path.join(os.homedir(), '.vibe')) { console.error('Refusing: that is the real identity directory.'); process.exit(1); }

fs.mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.VIBE_HOME = home;
process.env.CI = '1';                       // the package must not open the default (signed-in) browser itself
const log = console.error; console.error = () => {};   // keep the package's own chatter out of the way

(async () => {
  const init = require('../tools/init');
  const config = require('../config');
  const store = require('../store');
  const started = await init.handler({});
  const url = (started.data && started.data.login_url) || (started.structured && started.structured.login_url);
  if (!url) { log(started.display || 'Could not start sign-in.'); process.exit(1); }

  console.log(`\nSign in as @${expect} here (link is good for 5 minutes):\n\n  ${url}\n`);
  if (!process.argv.includes('--no-open')) {
    spawn('open', ['-na', 'Google Chrome', '--args', '--incognito', url], { stdio: 'ignore', detached: true }).unref();
    console.log('Opened it in a private Chrome window. Use the GitHub account for the lab identity, not your own.\n');
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const token = config.load().authToken;
    if (!token) continue;
    const who = await store.verifyAuthToken(token).catch(() => null);
    const handle = who && who.valid ? String(who.handle || '').toLowerCase() : null;
    if (handle === expect) { console.log(`Signed in as @${handle}. Lab home: ${home}`); process.exit(0); }
    // The wrong account (most likely your own) signed in: do not keep its credential in a lab directory.
    for (const f of ['config.json', 'auth.json', 'actor-session.json']) { try { fs.unlinkSync(path.join(home, f)); } catch {} }
    console.log(`That signed in as @${handle || 'an unverified account'}, not @${expect}. I deleted what was saved. Run this again and use the lab GitHub account.`);
    process.exit(2);
  }
  console.log('No sign-in within 5 minutes. Run this again when ready.');
  process.exit(3);
})();
