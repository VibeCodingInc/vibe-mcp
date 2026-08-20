/**
 * A valid credential IS being signed in. Asking the file was the bug.
 *
 * Observed 2026-08-01, in a single response from `vibe_dm`:
 *
 *     ⚠️ Not initialized. Run `vibe init` first.
 *     ────────────────────────
 *     vibe · 1 online
 *     @bagholder here
 *
 * One reply, two answers about whether you are signed in. The footer resolves identity
 * from the credential and worked; `requireInit()` asked `config.handle` and refused. The
 * config held a perfectly good token and no `username` at all.
 *
 * HOW A CONFIG GETS INTO THAT STATE, which is the part worth keeping: `save()` writes
 *
 *     username: config.handle || config.username || existing.username
 *
 * and when all three are absent that expression is `undefined` — which `JSON.stringify`
 * DROPS. So the key does not become null, it disappears, and nothing ever puts it back.
 * Meanwhile `saveAuthToken()` persisted the credential without recording whose it was, so
 * a sign-in could not repair it either. Invisible and permanent.
 *
 * Two fixes, and they belong together:
 *   · `isInitialized()` trusts the credential first (#107 — the credential is identity).
 *   · `saveAuthToken()` derives and stores the handle, so a token is never anonymous.
 *
 * Run: node --test tools/_credential-is-initialisation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub) =>
  `h.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

/** Run a fresh config module against a throwaway VIBE_HOME holding `cfg`. */
function withConfig(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-init-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const prev = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;

  for (const m of ['../config.js', '../auth-store.js']) delete require.cache[require.resolve(m)];
  const config = require('../config.js');
  require('../auth-store.js').clear();

  return {
    config,
    home,
    restore() {
      if (prev === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = prev;
      for (const m of ['../config.js', '../auth-store.js']) delete require.cache[require.resolve(m)];
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a token with no stored username still counts as signed in', () => {
  // The exact broken file: a credential, and no name anywhere.
  const c = withConfig({ authToken: tokenFor('vibetester1'), authMethod: 'github' });
  try {
    assert.equal(c.config.getHandle(), 'vibetester1', 'the credential names us');
    assert.equal(c.config.isInitialized(), true, 'so we are initialised — this was the bug');
  } finally { c.restore(); }
});

test('no credential and no handle is genuinely not initialised', () => {
  // The fix must not make everyone permanently "signed in".
  const c = withConfig({ notifications: 'all' });
  try {
    assert.equal(c.config.isInitialized(), false);
  } finally { c.restore(); }
});

test('a remembered handle with no credential still counts (signed out, known)', () => {
  // Legacy configs and the signed-out-but-remembered state must keep working.
  const c = withConfig({ username: 'brightseth' });
  try {
    assert.equal(c.config.isInitialized(), true);
  } finally { c.restore(); }
});

test('saving a token records whose it is, so the file is never anonymous', () => {
  const c = withConfig({});
  try {
    c.config.saveAuthToken(tokenFor('brightseth'));
    const onDisk = JSON.parse(fs.readFileSync(path.join(c.home, 'config.json'), 'utf8'));
    assert.equal(onDisk.username, 'brightseth',
      'a persisted credential must carry its identity — otherwise save() drops the key forever');
  } finally { c.restore(); }
});
