/**
 * "N others here" is only ever said about a room somebody actually saw.
 *
 * Round 7 of the #33 review answered Seth's truth check by finding the defect
 * underneath it: request() RESOLVES on transport failure, so a dead network
 * produced a successful-looking empty roster and the first screen said "0
 * others here" — a count of a room nobody looked at. Round 8 then found the
 * repair had traded one false claim for another: substituting a bare [] for an
 * anonymous roster stripped the public counts off it, and vibe_who went back to
 * telling a signed-out user "you're the only one here" while four people were
 * online.
 *
 * These run the REAL boundary — a local HTTP server behind the real request()
 * and the real store — because a stub of getActiveUsers() bypasses the wrapper
 * where both defects live. That is exactly why the earlier pin passed.
 *
 * Run: node --test tools/_presence-truth.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-presence-truth-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

// What the server should answer with next. Set per test.
let respond = () => ({ status: 200, body: { active: [], away: [] } });

const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    const { status, body } = respond(req);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
});
server.listen(0);
const port = server.address().port;
process.env.VIBE_API_URL = `http://127.0.0.1:${port}`;
after(() => server.close());

const store = require('../store/api.js');

test('a signed-out roster keeps its public counts all the way to who', async () => {
  // v1 shape: 200 with anonymous:true and counts. The array carries them as
  // non-enumerable properties; a wrapper that returns a fresh [] loses them.
  respond = () => ({ status: 200, body: { anonymous: true, active: [], away: [], counts: { active: 4 } } });
  const users = await store.getActiveUsers();
  assert.equal(users.anonymous, true, 'the anonymous flag did not survive the wrapper');
  assert.equal(users.counts?.active, 4, 'the public count did not survive the wrapper');

  const result = await store.getActiveUsersResult();
  assert.equal(result.ok, false, 'signed out is not a confirmed read');
  assert.equal(result.error, 'unauthenticated');
  assert.equal(result.users.counts?.active, 4, 'the outcome dropped the counts');
});

test('a hard 401 is the same fact, not a thrown failure', async () => {
  // v2 shape: 401 with no counts at all. Still "we cannot see who is here".
  respond = () => ({ status: 401, body: { error: 'unauthorized' } });
  const result = await store.getActiveUsersResult();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unauthenticated', '401 must not be reported as a transport failure');
});

test('a server error IS a failed read, not an empty room', async () => {
  respond = () => ({ status: 500, body: { success: false, error: 'boom' } });
  const result = await store.getActiveUsersResult();
  assert.equal(result.ok, false, 'a 500 rendered as a successful empty room');
  assert.notEqual(result.error, 'unauthenticated');
});

test('a populated room is a confirmed read with a true count', async () => {
  const now = new Date().toISOString();
  respond = () => ({ status: 200, body: {
    active: [
      { handle: 'zoe', status: 'active', lastSeen: now },
      { handle: 'ren', status: 'active', lastSeen: now },
    ],
    away: [],
  } });
  const result = await store.getActiveUsersResult();
  assert.equal(result.ok, true);
  assert.equal(result.users.length, 2);
});
