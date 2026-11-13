/**
 * What a session tells /vibe about where it is working: nothing.
 *
 * Every 30 seconds a session says "this person is here". Until 0.9.5 that
 * message also carried the full working directory path and the folder's name,
 * and the folder name ended up on the presence row every signed-in person can
 * read. This pins the promise in the README: nothing is taken from your
 * repository. The path is sent only on an explicit opt-in, and the folder name
 * is never sent as its own field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SECRET_DIR = 'acme-secret-client-zx91';
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;

test('a heartbeat carries no folder path, folder name, file or branch; the path only on opt-in', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && /\/presence$/.test(req.url.split('?')[0])) bodies.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-beat-'));
  const vh = path.join(root, '.vibe');
  const work = path.join(root, SECRET_DIR);
  fs.mkdirSync(vh, { recursive: true }); fs.mkdirSync(work);
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle: 'nell', token: jwt('nell'), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle: 'nell' }));
  process.env.VIBE_HOME = vh; process.env.VIBE_API_URL = `http://127.0.0.1:${server.address().port}`; process.env.CI = '1';
  delete process.env.VIBE_SESSION_BEACON;
  const was = process.cwd(); process.chdir(work); t.after(() => process.chdir(was));
  const quiet = console.error; console.error = () => {}; t.after(() => { console.error = quiet; });

  require('../auth-store').hydrate();
  const store = require('../store');

  // Default: with and without the legacy context argument.
  await store.heartbeat('nell', 'the scheduler lease');
  await store.heartbeat('nell', 'the scheduler lease', { mood: 'focused', file: 'src/billing/secret.ts', project: SECRET_DIR, model: 'x' });
  assert.equal(bodies.length, 2, 'the heartbeat did not reach the server');
  for (const raw of bodies) {
    const body = JSON.parse(raw);
    for (const key of ['cwd', 'project', 'file', 'branch', 'path', 'dir', 'repo']) assert.ok(!(key in body), `the heartbeat sent "${key}"`);
    assert.ok(!raw.includes(SECRET_DIR), 'the folder name is in the heartbeat');
    assert.ok(!raw.includes(root) && !raw.includes(os.homedir()), 'a path is in the heartbeat');
    assert.ok(!raw.includes('secret.ts'), 'a file name is in the heartbeat');
    assert.equal(body.workingOn, 'the scheduler lease', 'the line the person set still goes');
    assert.equal(body.source, 'mcp');
  }

  // Opt-in, for the person's own session list: the path, and still no `project`
  // field (that is the one the platform puts on the row other people can read).
  process.env.VIBE_SESSION_BEACON = '1';
  t.after(() => { delete process.env.VIBE_SESSION_BEACON; });
  await store.heartbeat('nell', 'the scheduler lease');
  const opted = JSON.parse(bodies[2]);
  assert.equal(fs.realpathSync(opted.cwd), fs.realpathSync(work));
  assert.ok(!('project' in opted), 'opting in to the session list also published the folder name');

  // Anything but an explicit yes is a no.
  for (const v of ['0', 'false', '', 'yes please']) {
    process.env.VIBE_SESSION_BEACON = v;
    await store.heartbeat('nell', 'x');
    assert.ok(!('cwd' in JSON.parse(bodies.at(-1))), `VIBE_SESSION_BEACON=${JSON.stringify(v)} sent the path`);
  }
});

test('opening a session says nothing about the person that they did not say', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url.split('?')[0], body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const quiet = console.error; console.error = () => {}; t.after(() => { console.error = quiet; });

  // A fresh copy of the store, pointed at this server.
  process.env.VIBE_API_URL = `http://127.0.0.1:${server.address().port}`;
  for (const key of Object.keys(require.cache)) if (/[\\/]store[\\/]/.test(key)) delete require.cache[key];
  const store = require('../store');

  // A session opens for someone who has set no line (presence.js calls it this way).
  await store.registerSession('sess_1', 'nell');
  assert.ok(seen.length > 0, 'registration did not reach the server');
  assert.ok(!seen.some((r) => r.path === '/api/users'), 'a profile write was made for someone who set nothing');
  for (const r of seen) {
    assert.ok(!/something cool/i.test(r.body), 'an invented line was sent in the person\'s name');
    assert.ok(!/"building"/.test(r.body), 'a building line was sent that nobody set');
  }

  // Blank is not a line either.
  for (const blank of ['', '   ', null, undefined]) await store.registerSession('sess_1', 'nell', blank);
  assert.ok(!seen.some((r) => r.path === '/api/users'));

  // Their own words, when they gave some, go exactly as given.
  await store.registerSession('sess_1', 'nell', '  the scheduler lease ');
  const profile = seen.filter((r) => r.path === '/api/users');
  assert.equal(profile.length, 1);
  assert.deepEqual(JSON.parse(profile[0].body), { username: 'nell', building: 'the scheduler lease' });
});

