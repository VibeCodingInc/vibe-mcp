/**
 * Session Journal Store — Local SQLite-backed session tracking
 *
 * Passively records tool calls and messages per MCP session.
 * Shares database with Vibe Terminal at ~/.vibecodings/sessions.db
 * Follows the store/sqlite.js singleton pattern with graceful no-op fallback.
 */

let Database;
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.vibecodings', 'sessions.db');

class SessionStore {
  constructor() {
    if (!Database) {
      Database = require('better-sqlite3');
    }

    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');

    this.ensureSchema();
    this.prepareStatements();
  }

  ensureSchema() {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_sessions_handle
      ON sessions(handle, started_at);

      CREATE INDEX IF NOT EXISTS idx_sessions_repo
      ON sessions(git_repo, started_at);

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

      CREATE INDEX IF NOT EXISTS idx_journal_session
      ON session_journal(session_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_journal_event_type
      ON session_journal(event_type);
    `);
  }

  prepareStatements() {
    this.stmts = {
      startSession: this.db.prepare(`
        INSERT OR REPLACE INTO sessions
        (session_id, handle, machine_id, started_at, git_repo, git_branch, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      endSession: this.db.prepare(`
        UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?
      `),

      logEntry: this.db.prepare(`
        INSERT INTO session_journal
        (session_id, timestamp, event_type, tool_name, target, summary, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      getSession: this.db.prepare(`
        SELECT * FROM sessions WHERE session_id = ?
      `),

      getRecentSessions: this.db.prepare(`
        SELECT * FROM sessions
        WHERE handle = ?
        ORDER BY started_at DESC
        LIMIT ?
      `),

      getRecentSessionsByRepo: this.db.prepare(`
        SELECT * FROM sessions
        WHERE handle = ? AND git_repo = ?
        ORDER BY started_at DESC
        LIMIT ?
      `),

      getSessionJournal: this.db.prepare(`
        SELECT * FROM session_journal
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT ?
      `),

      getLastSession: this.db.prepare(`
        SELECT * FROM sessions
        WHERE handle = ? AND ended_at IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT 1
      `),

      getLastSessionByRepo: this.db.prepare(`
        SELECT * FROM sessions
        WHERE handle = ? AND git_repo = ? AND ended_at IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT 1
      `)
    };
  }

  /**
   * Start a new session
   */
  startSession(sessionId, handle, { repo = null, branch = null, machineId = null, parentId = null } = {}) {
    this.stmts.startSession.run(
      sessionId,
      handle,
      machineId || os.hostname(),
      new Date().toISOString(),
      repo,
      branch,
      parentId
    );
    return { session_id: sessionId };
  }

  /**
   * End a session with optional summary
   */
  endSession(sessionId, summary = null) {
    this.stmts.endSession.run(
      new Date().toISOString(),
      summary,
      sessionId
    );
  }

  /**
   * Log a tool call to the journal
   */
  logToolCall(sessionId, toolName, target = null, summary = null) {
    this.stmts.logEntry.run(
      sessionId,
      new Date().toISOString(),
      'tool_call',
      toolName,
      target,
      summary,
      null
    );
  }

  /**
   * Log a message (sent or received)
   */
  logMessage(sessionId, direction, handle, preview = null) {
    this.stmts.logEntry.run(
      sessionId,
      new Date().toISOString(),
      direction === 'sent' ? 'message_sent' : 'message_received',
      null,
      handle,
      preview,
      null
    );
  }

  /**
   * Log a free-form note
   */
  logNote(sessionId, note) {
    this.stmts.logEntry.run(
      sessionId,
      new Date().toISOString(),
      'note',
      null,
      null,
      note,
      null
    );
  }

  /**
   * Get recent sessions for a handle
   */
  getRecentSessions(handle, { limit = 10, repo = null } = {}) {
    if (repo) {
      return this.stmts.getRecentSessionsByRepo.all(handle, repo, limit);
    }
    return this.stmts.getRecentSessions.all(handle, limit);
  }

  /**
   * Get journal entries for a session
   */
  getSessionJournal(sessionId, { limit = 100 } = {}) {
    return this.stmts.getSessionJournal.all(sessionId, limit);
  }

  /**
   * Get the last completed session for a handle
   */
  getLastSession(handle, { repo = null } = {}) {
    if (repo) {
      return this.stmts.getLastSessionByRepo.get(handle, repo);
    }
    return this.stmts.getLastSession.get(handle);
  }

  /**
   * Get a specific session by ID
   */
  getSession(sessionId) {
    return this.stmts.getSession.get(sessionId);
  }

  close() {
    this.db.close();
  }
}

// Singleton with graceful fallback
let instance = null;

function getInstance() {
  if (!instance) {
    try {
      instance = new SessionStore();
    } catch (error) {
      process.stderr.write(`[sessions] Failed to initialize: ${error.message}\n`);
      return {
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
    }
  }
  return instance;
}

// Allow tests to reset the singleton
getInstance._reset = function () {
  if (instance) {
    try { instance.close(); } catch (e) {}
    instance = null;
  }
};

module.exports = getInstance;
