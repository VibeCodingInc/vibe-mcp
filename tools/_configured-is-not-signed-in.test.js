/**
 * "Configured" is not "signed in", and the recovery path must know the difference.
 *
 * Seth ran `npx slashvibe-mcp` on the Mac Studio to clear a credential that had expired
 * 23 days earlier. It printed:
 *
 *     /vibe is configured. Restart your coding agent (Claude Code / Codex / Cursor).
 *
 * and exited, changing nothing. The gate was `!config.isInitialized() && !getAuthToken()`
 * — and `getAuthToken()` returns a token whether or not it is still valid. A file
 * existing stood in for a verified state, so the one command documented for fixing this
 * told him there was nothing to fix, and offered advice (restart your agent) that could
 * not possibly help.
 *
 * That is the same defect as the green dot promising a reply, the board reporting an
 * empty room while four people were online, and the site claiming an invite gate nothing
 * enforced. It is the most expensive version, because it sits on the RECOVERY path: the
 * place someone goes when they already suspect something is wrong.
 *
 * `inspectToken()` is deliberately local — it decodes `exp` rather than asking the
 * server, because this runs where the network may be the broken thing. It cannot prove a
 * token is good; only the server can. It reliably catches a credential that is
 * definitively over, which is what actually stranded someone.
 *
 * Run: node --test tools/_configured-is-not-signed-in.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const authStore = require('../auth-store.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sub, expSeconds) => `h.${b64({ sub, exp: expSeconds })}.sig`;
const now = () => Math.floor(Date.now() / 1000);

test('an expired credential is not a session', () => {
  // The Mac Studio case, exactly: attributable, well-formed, and over.
  const c = authStore.inspectToken(token('brightseth', now() - 23 * 86400));
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'expired');
  assert.equal(c.handle, 'brightseth', 'we still know WHO it was — the message needs the name');
  assert.ok(c.expiresAt < Date.now());
});

test('a live credential is a session, and names its owner', () => {
  const c = authStore.inspectToken(token('vibetester1', now() + 30 * 86400));
  assert.equal(c.ok, true);
  assert.equal(c.reason, 'usable');
  assert.equal(c.handle, 'vibetester1');
});

test('an unattributable token is refused rather than trusted', () => {
  const c = authStore.inspectToken('not-a-jwt');
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'unattributable');
  assert.equal(c.handle, null);
});

test('no token at all is distinct from a broken one', () => {
  // These take different branches: "never signed in" runs setup silently, while "signed
  // in once, not any more" must SAY so first. Collapsing them is how someone gets a
  // wizard with no explanation of why it appeared.
  const c = authStore.inspectToken(null);
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'none');
});

test('a token with no exp claim is left alone', () => {
  // Legacy tokens carry no exp. Refusing them here would sign people out to fix a
  // display bug — a fix worse than the defect.
  const c = authStore.inspectToken(`h.${b64({ sub: 'brightseth' })}.sig`);
  assert.equal(c.ok, true);
  assert.equal(c.expiresAt, null);
});
