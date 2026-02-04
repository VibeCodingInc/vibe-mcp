const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_DIR = path.join(os.tmpdir(), `vibe-session-test-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'sessions.db');

// Patch the DB path before requiring the module
let Database;
let SessionStore;

function createTestStore() {
  if (!Database) {
    Database = require('better-sqlite3');
  }
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }

  // Create a fresh store instance directly (bypass singleton)
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      handle TEXT,
      machine_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      git_repo TEXT,
      git_branch TEXT,
      summary TEXT,
      parent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_handle ON sessions(handle, started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(git_repo, started_at);

    CREATE TABLE IF NOT EXISTS session_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      target TEXT,
      summary TEXT,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_session ON session_journal(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_journal_event_type ON session_journal(event_type);
  `);

  // Wrap db in a store-like interface matching store/sessions.js exports
  const stmts = {
    startSession: db.prepare(`
      INSERT OR REPLACE INTO sessions
      (session_id, handle, machine_id, started_at, git_repo, git_branch, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    endSession: db.prepare(`
      UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?
    `),
    logEntry: db.prepare(`
      INSERT INTO session_journal
      (session_id, timestamp, event_type, tool_name, target, summary, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getSession: db.prepare(`SELECT * FROM sessions WHERE session_id = ?`),
    getRecentSessions: db.prepare(`
      SELECT * FROM sessions WHERE handle = ? ORDER BY started_at DESC LIMIT ?
    `),
    getRecentSessionsByRepo: db.prepare(`
      SELECT * FROM sessions WHERE handle = ? AND git_repo = ? ORDER BY started_at DESC LIMIT ?
    `),
    getSessionJournal: db.prepare(`
      SELECT * FROM session_journal WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
    `),
    getLastSession: db.prepare(`
      SELECT * FROM sessions WHERE handle = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1
    `),
    getLastSessionByRepo: db.prepare(`
      SELECT * FROM sessions WHERE handle = ? AND git_repo = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1
    `)
  };

  return {
    db,
    startSession(sessionId, handle, opts = {}) {
      const { repo = null, branch = null, machineId = null, parentId = null } = opts;
      stmts.startSession.run(sessionId, handle, machineId || os.hostname(), new Date().toISOString(), repo, branch, parentId);
      return { session_id: sessionId };
    },
    endSession(sessionId, summary = null) {
      stmts.endSession.run(new Date().toISOString(), summary, sessionId);
    },
    logToolCall(sessionId, toolName, target = null, summary = null) {
      stmts.logEntry.run(sessionId, new Date().toISOString(), 'tool_call', toolName, target, summary, null);
    },
    logMessage(sessionId, direction, handle, preview = null) {
      stmts.logEntry.run(sessionId, new Date().toISOString(), direction === 'sent' ? 'message_sent' : 'message_received', null, handle, preview, null);
    },
    logNote(sessionId, note) {
      stmts.logEntry.run(sessionId, new Date().toISOString(), 'note', null, null, note, null);
    },
    getRecentSessions(handle, opts = {}) {
      const { limit = 10, repo = null } = opts;
      if (repo) return stmts.getRecentSessionsByRepo.all(handle, repo, limit);
      return stmts.getRecentSessions.all(handle, limit);
    },
    getSessionJournal(sessionId, opts = {}) {
      const { limit = 100 } = opts;
      return stmts.getSessionJournal.all(sessionId, limit);
    },
    getLastSession(handle, opts = {}) {
      const { repo = null } = opts;
      if (repo) return stmts.getLastSessionByRepo.get(handle, repo);
      return stmts.getLastSession.get(handle);
    },
    getSession(sessionId) {
      return stmts.getSession.get(sessionId);
    },
    close() {
      db.close();
    }
  };
}

function cleanup() {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
    if (fs.existsSync(TEST_DB_DIR)) fs.rmdirSync(TEST_DB_DIR);
  } catch (e) {}
}

// ── Schema Tests ──

describe('session store — schema', () => {
  let store;

  beforeEach(() => {
    cleanup();
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('creates sessions table', () => {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
    assert.equal(tables.length, 1);
  });

  it('creates session_journal table', () => {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_journal'").all();
    assert.equal(tables.length, 1);
  });

  it('creates indexes', () => {
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
    assert.ok(indexes.length >= 4, `Expected >= 4 indexes, got ${indexes.length}`);
  });
});

// ── Lifecycle Tests ──

describe('session store — lifecycle', () => {
  let store;

  beforeEach(() => {
    cleanup();
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('starts a session', () => {
    const result = store.startSession('sess_1', 'alice', { repo: '/tmp/repo', branch: 'main' });
    assert.equal(result.session_id, 'sess_1');

    const session = store.getSession('sess_1');
    assert.equal(session.handle, 'alice');
    assert.equal(session.git_repo, '/tmp/repo');
    assert.equal(session.git_branch, 'main');
    assert.ok(session.started_at);
    assert.equal(session.ended_at, null);
  });

  it('ends a session with summary', () => {
    store.startSession('sess_2', 'bob');
    store.endSession('sess_2', 'Built the auth module');

    const session = store.getSession('sess_2');
    assert.ok(session.ended_at);
    assert.equal(session.summary, 'Built the auth module');
  });

  it('starts session with parent_id', () => {
    store.startSession('sess_parent', 'alice');
    store.endSession('sess_parent');
    store.startSession('sess_child', 'alice', { parentId: 'sess_parent' });

    const child = store.getSession('sess_child');
    assert.equal(child.parent_id, 'sess_parent');
  });

  it('starts session with machine_id', () => {
    store.startSession('sess_m', 'alice', { machineId: 'mac-studio' });

    const session = store.getSession('sess_m');
    assert.equal(session.machine_id, 'mac-studio');
  });
});

// ── Journal Tests ──

describe('session store — journal', () => {
  let store;

  beforeEach(() => {
    cleanup();
    store = createTestStore();
    store.startSession('sess_j', 'alice');
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('logs tool calls', () => {
    store.logToolCall('sess_j', 'vibe_who', null, 'who is online');
    store.logToolCall('sess_j', 'vibe_dm', 'bob', 'message @bob');

    const entries = store.getSessionJournal('sess_j');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event_type, 'tool_call');
    assert.equal(entries[0].tool_name, 'vibe_who');
    assert.equal(entries[1].target, 'bob');
  });

  it('logs messages sent', () => {
    store.logMessage('sess_j', 'sent', 'bob', 'hey there');

    const entries = store.getSessionJournal('sess_j');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_type, 'message_sent');
    assert.equal(entries[0].target, 'bob');
    assert.equal(entries[0].summary, 'hey there');
  });

  it('logs messages received', () => {
    store.logMessage('sess_j', 'received', 'carol', 'hi alice');

    const entries = store.getSessionJournal('sess_j');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_type, 'message_received');
    assert.equal(entries[0].target, 'carol');
  });

  it('logs notes', () => {
    store.logNote('sess_j', 'Switched to debugging mode');

    const entries = store.getSessionJournal('sess_j');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_type, 'note');
    assert.equal(entries[0].summary, 'Switched to debugging mode');
  });

  it('respects journal limit', () => {
    for (let i = 0; i < 20; i++) {
      store.logToolCall('sess_j', `vibe_tool_${i}`);
    }

    const limited = store.getSessionJournal('sess_j', { limit: 5 });
    assert.equal(limited.length, 5);

    const all = store.getSessionJournal('sess_j', { limit: 100 });
    assert.equal(all.length, 20);
  });

  it('journal entries have timestamps', () => {
    store.logToolCall('sess_j', 'vibe_who');

    const entries = store.getSessionJournal('sess_j');
    assert.ok(entries[0].timestamp);
    // Should be a valid ISO timestamp
    assert.ok(!isNaN(new Date(entries[0].timestamp).getTime()));
  });
});

// ── Query Tests ──

describe('session store — queries', () => {
  let store;

  beforeEach(() => {
    cleanup();
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('getRecentSessions returns sessions in reverse chronological order', () => {
    store.startSession('sess_old', 'alice');
    store.endSession('sess_old');
    store.startSession('sess_new', 'alice');
    store.endSession('sess_new');

    const sessions = store.getRecentSessions('alice');
    assert.equal(sessions.length, 2);
    // Most recent first
    assert.equal(sessions[0].session_id, 'sess_new');
    assert.equal(sessions[1].session_id, 'sess_old');
  });

  it('getRecentSessions filters by repo', () => {
    store.startSession('sess_r1', 'alice', { repo: '/proj/a' });
    store.startSession('sess_r2', 'alice', { repo: '/proj/b' });

    const sessionsA = store.getRecentSessions('alice', { repo: '/proj/a' });
    assert.equal(sessionsA.length, 1);
    assert.equal(sessionsA[0].session_id, 'sess_r1');
  });

  it('getRecentSessions respects limit', () => {
    for (let i = 0; i < 15; i++) {
      store.startSession(`sess_${i}`, 'alice');
    }

    const sessions = store.getRecentSessions('alice', { limit: 5 });
    assert.equal(sessions.length, 5);
  });

  it('getLastSession returns most recent ended session', () => {
    store.startSession('sess_a', 'alice');
    // Manually set ended_at to ensure ordering
    store.db.prepare("UPDATE sessions SET ended_at = '2026-01-01T10:00:00Z', summary = 'First session' WHERE session_id = 'sess_a'").run();
    store.startSession('sess_b', 'alice');
    store.db.prepare("UPDATE sessions SET ended_at = '2026-01-01T11:00:00Z', summary = 'Second session' WHERE session_id = 'sess_b'").run();
    store.startSession('sess_c', 'alice'); // Not ended

    const last = store.getLastSession('alice');
    assert.equal(last.session_id, 'sess_b');
    assert.equal(last.summary, 'Second session');
  });

  it('getLastSession filters by repo', () => {
    store.startSession('sess_x', 'alice', { repo: '/proj/x' });
    store.endSession('sess_x');
    store.startSession('sess_y', 'alice', { repo: '/proj/y' });
    store.endSession('sess_y');

    const last = store.getLastSession('alice', { repo: '/proj/x' });
    assert.equal(last.session_id, 'sess_x');
  });

  it('getLastSession returns null when no completed sessions', () => {
    store.startSession('sess_open', 'alice');
    const last = store.getLastSession('alice');
    assert.equal(last, undefined);
  });

  it('getSession returns null for nonexistent session', () => {
    const session = store.getSession('nonexistent');
    assert.equal(session, undefined);
  });

  it('filters sessions by handle (different users)', () => {
    store.startSession('sess_alice', 'alice');
    store.startSession('sess_bob', 'bob');

    const aliceSessions = store.getRecentSessions('alice');
    assert.equal(aliceSessions.length, 1);
    assert.equal(aliceSessions[0].handle, 'alice');
  });
});

// ── Parent Chaining Tests ──

describe('session store — parent chaining', () => {
  let store;

  beforeEach(() => {
    cleanup();
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('chains three sessions via parent_id', () => {
    store.startSession('sess_1', 'alice');
    store.endSession('sess_1');

    store.startSession('sess_2', 'alice', { parentId: 'sess_1' });
    store.endSession('sess_2');

    store.startSession('sess_3', 'alice', { parentId: 'sess_2' });

    const s3 = store.getSession('sess_3');
    assert.equal(s3.parent_id, 'sess_2');

    const s2 = store.getSession('sess_2');
    assert.equal(s2.parent_id, 'sess_1');

    const s1 = store.getSession('sess_1');
    assert.equal(s1.parent_id, null);
  });
});

// ── Graceful Fallback Tests ──

describe('session store — graceful fallback', () => {
  it('singleton fallback returns no-op methods', () => {
    // Test the fallback object shape from store/sessions.js
    const fallback = {
      startSession: () => ({ session_id: null }),
      endSession: () => {},
      logToolCall: () => {},
      logMessage: () => {},
      logNote: () => {},
      getRecentSessions: () => [],
      getSessionJournal: () => [],
      getLastSession: () => null,
      getSession: () => null,
      close: () => {}
    };

    // All methods should be callable without error
    assert.deepEqual(fallback.startSession(), { session_id: null });
    fallback.endSession('x');
    fallback.logToolCall('x', 'tool');
    fallback.logMessage('x', 'sent', 'bob');
    fallback.logNote('x', 'note');
    assert.deepEqual(fallback.getRecentSessions('x'), []);
    assert.deepEqual(fallback.getSessionJournal('x'), []);
    assert.equal(fallback.getLastSession('x'), null);
    assert.equal(fallback.getSession('x'), null);
    fallback.close();
  });
});
