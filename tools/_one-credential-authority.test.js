/**
 * One identity, one authority — and the authority is whichever credential still WORKS.
 *
 * `hydrate()` took `cfg.authToken` unconditionally and consulted `auth.json` only when
 * `config.json` had no token AT ALL. So a machine holding a dead token in one file and a
 * live one in the other hydrated with the dead one and reported itself signed in.
 * Reproduced before the fix:
 *
 *     hydrate chose: expired | isAuthenticated(): true
 *
 * Seth's Mac Studio was in exactly that state for 23 days — a 1-hour token in
 * `config.json`, a 30-day token in `auth.json`, both naming @brightseth. It only stopped
 * mattering because he signed in again.
 *
 * Presence order is unchanged: `config.json` still wins when it is usable. What changed is
 * that "present" is no longer mistaken for "usable". Falling back only on ABSENCE means
 * the freshest credential loses to the first one on disk — the "several credentials for
 * one identity" failure canon law 3 exists to prevent. With 30-day logins every machine
 * eventually holds a stale one, so this was a matter of when, not whether.
 *
 * The check is local by design. `inspectToken` decodes `exp` rather than asking the
 * server, because hydrate runs at boot where the network may be the broken thing. It
 * cannot prove a token is GOOD — only the server can, and `markVerified()` records that
 * later. It reliably rejects one that is definitively over.
 *
 * Run: node --test tools/_one-credential-authority.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const token = (sub, exp) => `h.${b64({ sub, exp })}.sig`;
const LIVE = () => token('brightseth', now() + 30 * 86400);
const DEAD = () => token('brightseth', now() - 23 * 86400);

/** Hydrate a fresh auth-store against a throwaway HOME holding these two files. */
function hydrateWith({ config: cfg, auth }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cred-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg || {}));
  if (auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth));

  const prev = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  for (const m of ['../auth-store.js', '../config.js']) delete require.cache[require.resolve(m)];
  const store = require('../auth-store.js');
  store.clear();
  store.hydrate();

  const held = store.getToken();
  const result = {
    reason: held ? store.inspectToken(held).reason : 'none',
    handle: store.getHandle(),
    authenticated: store.isAuthenticated(),
    rejected: store.hasRejectedCredential(),
  };

  if (prev === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = prev;
  for (const m of ['../auth-store.js', '../config.js']) delete require.cache[require.resolve(m)];
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test('a dead credential does not beat a live one in another file', () => {
  // THE BUG. config.json is consulted first, and used to win on presence alone.
  const r = hydrateWith({
    config: { handle: 'brightseth', authToken: DEAD() },
    auth: { token: LIVE() },
  });
  assert.equal(r.reason, 'usable', 'hydrate must select the credential that still works');
  assert.equal(r.authenticated, true);
  assert.equal(r.handle, 'brightseth');
});

test('config.json still wins when it is usable', () => {
  // The fix must not reorder preference — only stop confusing present with usable.
  const cfgToken = LIVE();
  const r = hydrateWith({
    config: { handle: 'brightseth', authToken: cfgToken },
    auth: { token: LIVE() },
  });
  assert.equal(r.reason, 'usable');
  assert.equal(r.authenticated, true);
});

test('every credential dead is signed OUT, and says so', () => {
  const r = hydrateWith({
    config: { handle: 'brightseth', authToken: DEAD() },
    auth: { token: DEAD() },
  });
  assert.equal(r.authenticated, false, 'the least-bad option is not a session');
  assert.equal(r.rejected, true, 'a rejected credential must be distinguishable from none');
});

test('no credential at all is NOT the same state as a rejected one', () => {
  // This distinction drives display: with no credential the remembered handle is the
  // best we have, but with a REJECTED one it is a name nothing backs (#110). Collapsing
  // them puts an unsupported identity on screen.
  const r = hydrateWith({ config: { handle: 'brightseth' }, auth: null });
  assert.equal(r.authenticated, false);
  assert.equal(r.rejected, false, 'absence is honest; rejection is not');
});

test('a single usable credential in config.json alone still works', () => {
  // The overwhelmingly common install. A regression here breaks everyone.
  const r = hydrateWith({ config: { handle: 'brightseth', authToken: LIVE() }, auth: null });
  assert.equal(r.reason, 'usable');
  assert.equal(r.authenticated, true);
});

test('an unattributable token is skipped in favour of a usable one', () => {
  // Garbage in the first slot must not strand a working credential behind it.
  const r = hydrateWith({
    config: { handle: 'brightseth', authToken: 'not-a-jwt' },
    auth: { token: LIVE() },
  });
  assert.equal(r.reason, 'usable');
  assert.equal(r.handle, 'brightseth');
});
