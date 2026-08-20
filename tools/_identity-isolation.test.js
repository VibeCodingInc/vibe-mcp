// Identity-isolation regression (ported from platform #262).
//
// One identity-directory definition (vibe-home.js): unset → ~/.vibe; set
// non-empty → that dir; set-but-empty → throw (never guess). Isolated sessions
// never read the shared legacy fallback, never overwrite ~/.vibe, and identity
// configs are written 0600 in 0700 directories.

process.env.VIBE_SETUP_NO_AUTORUN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config.js resolves its paths at require time from process.env, so each case
// re-requires the client modules with a fresh cache under a controlled env.
function freshRequire(mod) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/vibe-mcp/') && !key.includes('/node_modules/')) delete require.cache[key];
  }
  return require(mod);
}

function withEnv(env, fn) {
  const saved = { HOME: process.env.HOME, VIBE_HOME: process.env.VIBE_HOME };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-iso-'));
  process.env.HOME = home;
  if (env.VIBE_HOME === undefined) delete process.env.VIBE_HOME;
  else process.env.VIBE_HOME = env.VIBE_HOME(home);
  try {
    return fn(home);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.VIBE_HOME === undefined) delete process.env.VIBE_HOME;
    else process.env.VIBE_HOME = saved.VIBE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── vibe-home.js: the one definition ──────────────────────────────────────

test('vibeHome: unset → ~/.vibe', () => {
  withEnv({ VIBE_HOME: undefined }, (home) => {
    const { vibeHome, isIsolated } = freshRequire('../vibe-home');
    assert.equal(vibeHome(), path.join(home, '.vibe'));
    assert.equal(isIsolated(), false);
  });
});

test('vibeHome: set non-empty → that dir, ~-expanded', () => {
  withEnv({ VIBE_HOME: () => '~/.vibe-vibetester1' }, (home) => {
    const { vibeHome, isIsolated } = freshRequire('../vibe-home');
    assert.equal(vibeHome(), path.join(home, '.vibe-vibetester1'));
    assert.equal(isIsolated(), true);
  });
});

for (const val of ['', '   ']) {
  test(`vibeHome: set-but-empty (${JSON.stringify(val)}) → throws`, () => {
    withEnv({ VIBE_HOME: () => val }, () => {
      const { vibeHome } = freshRequire('../vibe-home');
      assert.throws(() => vibeHome(), /VIBE_HOME is set but empty/);
    });
  });
}

// ── config.js honors isolation ────────────────────────────────────────────

function plantShared(home) {
  fs.mkdirSync(path.join(home, '.vibecodings'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.vibecodings', 'config.json'),
    JSON.stringify({ handle: 'brightseth', username: 'brightseth' }),
  );
  fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
  fs.writeFileSync(path.join(home, '.vibe', 'config.json'), JSON.stringify({ username: 'brightseth' }));
}

test('an isolated session never reads the shared legacy fallback', () => {
  withEnv({ VIBE_HOME: (h) => path.join(h, '.vibe-vibetester1') }, (home) => {
    plantShared(home);
    const config = freshRequire('../config');
    assert.equal(config.load().handle, null); // signed out, NOT brightseth
  });
});

test('a non-isolated session keeps the legacy fallback (backward compat)', () => {
  withEnv({ VIBE_HOME: undefined }, (home) => {
    fs.mkdirSync(path.join(home, '.vibecodings'), { recursive: true });
    fs.writeFileSync(path.join(home, '.vibecodings', 'config.json'), JSON.stringify({ handle: 'brightseth' }));
    const config = freshRequire('../config');
    assert.equal(config.load().handle, 'brightseth');
  });
});

test('an isolated session reads and writes only inside VIBE_HOME', () => {
  withEnv({ VIBE_HOME: (h) => path.join(h, '.vibe-vibetester1') }, (home) => {
    plantShared(home);
    const isolated = path.join(home, '.vibe-vibetester1');
    const config = freshRequire('../config');
    config.save({ handle: 'vibetester1' });
    assert.ok(fs.existsSync(path.join(isolated, 'config.json')));
    assert.equal(config.load().handle, 'vibetester1');
    const shared = JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'config.json'), 'utf8'));
    assert.equal(shared.username, 'brightseth'); // untouched
  });
});

test('config.json is 0600 in a 0700 directory; a loose pre-existing dir is tightened', () => {
  withEnv({ VIBE_HOME: undefined }, (home) => {
    fs.mkdirSync(path.join(home, '.vibe'), { recursive: true, mode: 0o755 });
    const config = freshRequire('../config');
    config.save({ handle: 'qa_perms' });
    assert.equal(fs.statSync(path.join(home, '.vibe', 'config.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.vibe')).mode & 0o777, 0o700);
  });
});

test('an empty VIBE_HOME fails the config module loudly instead of merging identities', () => {
  withEnv({ VIBE_HOME: () => '' }, () => {
    assert.throws(() => freshRequire('../config'), /VIBE_HOME is set but empty/);
  });
});

// ── setup.js saveAuthConfig honors VIBE_HOME ──────────────────────────────

test('setup.saveAuthConfig writes inside VIBE_HOME (0700/0600) and never touches ~/.vibe', () => {
  withEnv({ VIBE_HOME: (h) => path.join(h, '.vibe-vibetester1') }, (home) => {
    fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
    fs.writeFileSync(path.join(home, '.vibe', 'config.json'), JSON.stringify({ username: 'brightseth', authToken: 'studio' }));
    const isolated = path.join(home, '.vibe-vibetester1');
    const setup = freshRequire('../setup');
    setup.saveAuthConfig('vibetester1', 'tester-token');
    const written = JSON.parse(fs.readFileSync(path.join(isolated, 'config.json'), 'utf8'));
    assert.equal(written.handle, 'vibetester1');
    assert.equal(written.authToken, 'tester-token');
    assert.equal(fs.statSync(path.join(isolated, 'config.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(isolated).mode & 0o777, 0o700);
    const studio = JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'config.json'), 'utf8'));
    assert.equal(studio.username, 'brightseth'); // Studio profile survives
  });
});

// ── actor-session paths honor the one definition ──────────────────────────

test('actorPaths uses VIBE_HOME and refuses an empty one', () => {
  withEnv({ VIBE_HOME: undefined }, (home) => {
    const actorSession = freshRequire('../actor-session');
    const isolated = path.join(home, '.vibe-vibetester1');
    assert.equal(actorSession.actorPaths({ HOME: home, VIBE_HOME: isolated }).directory, isolated);
    assert.throws(() => actorSession.actorPaths({ HOME: home, VIBE_HOME: '' }), /VIBE_HOME is set but empty/);
  });
});
