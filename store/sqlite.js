/**
 * SQLite Message Store - Local persistence for v2 messaging
 *
 * Shares database with Vibe Terminal app at ~/.vibecodings/sessions.db
 * Schema matches src-tauri/src/db.rs exactly (LocalMessage struct)
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const DB_PATH = path.join(os.homedir(), '.vibecodings', 'sessions.db');

class MessageStore {
  constructor() {
    // Ensure directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency with Tauri app
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');

    // Ensure messages table exists (should already exist from Tauri, but just in case)
    this.ensureSchema();

    // Prepare statements for performance
    this.prepareStatements();
  }

  ensureSchema() {
    // This matches the Tauri schema + V2 Postgres fields
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        local_id TEXT PRIMARY KEY,
        server_id TEXT,
        thread_id TEXT,
        from_handle TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
        sent_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        synced_at TEXT,
        retry_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(from_handle, to_handle, created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_thread_id
      ON messages(thread_id);

      CREATE INDEX IF NOT EXISTS idx_messages_server_id
      ON messages(server_id);

      CREATE INDEX IF NOT EXISTS idx_messages_status
      ON messages(status);

      CREATE INDEX IF NOT EXISTS idx_messages_synced
      ON messages(synced_at);
    `);
  }

  prepareStatements() {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT OR REPLACE INTO messages
        (local_id, server_id, thread_id, from_handle, to_handle, content, created_at, status,
         sent_at, delivered_at, read_at, synced_at, retry_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      getThread: this.db.prepare(`
        SELECT local_id, server_id, thread_id, from_handle, to_handle, content, created_at,
               status, sent_at, delivered_at, read_at, synced_at, retry_count
        FROM messages
        WHERE (from_handle = ? AND to_handle = ?)
           OR (from_handle = ? AND to_handle = ?)
        ORDER BY created_at ASC
        LIMIT ?
      `),

      updateStatus: this.db.prepare(`
        UPDATE messages
        SET status = ?, server_id = COALESCE(?, server_id), thread_id = COALESCE(?, thread_id), sent_at = COALESCE(?, sent_at)
        WHERE local_id = ?
      `),

      getInboxThreads: this.db.prepare(`
        WITH thread_partners AS (
          SELECT DISTINCT
            CASE WHEN from_handle = ? THEN to_handle ELSE from_handle END as partner
          FROM messages
          WHERE from_handle = ? OR to_handle = ?
        ),
        latest_messages AS (
          SELECT
            CASE WHEN from_handle = ? THEN to_handle ELSE from_handle END as partner,
            local_id, server_id, from_handle, to_handle, content, created_at,
            status, sent_at, delivered_at, read_at, synced_at, retry_count,
            ROW_NUMBER() OVER (PARTITION BY CASE WHEN from_handle = ? THEN to_handle ELSE from_handle END
                               ORDER BY created_at DESC) as rn
          FROM messages
          WHERE from_handle = ? OR to_handle = ?
        ),
        unread_counts AS (
          SELECT
            CASE WHEN to_handle = ? THEN from_handle ELSE to_handle END as partner,
            COUNT(*) as unread
          FROM messages
          WHERE to_handle = ? AND status IN ('sent', 'delivered')
          GROUP BY partner
        )
        SELECT
          lm.partner, lm.local_id, lm.server_id, lm.from_handle, lm.to_handle,
          lm.content, lm.created_at, lm.status, lm.sent_at, lm.delivered_at,
          lm.read_at, lm.synced_at, lm.retry_count,
          COALESCE(uc.unread, 0) as unread_count
        FROM latest_messages lm
        LEFT JOIN unread_counts uc ON lm.partner = uc.partner
        WHERE lm.rn = 1
        ORDER BY lm.created_at DESC
      `),

      markThreadRead: this.db.prepare(`
        UPDATE messages
        SET status = 'read', read_at = ?
        WHERE from_handle = ? AND to_handle = ? AND status IN ('sent', 'delivered')
      `)
    };
  }

  /**
   * Save a local message (optimistic - before server confirmation)
   */
  saveLocalMessage(message) {
    const {
      local_id = randomUUID(),
      server_id = null,
      thread_id = null,
      from_handle,
      to_handle,
      content,
      created_at = new Date().toISOString(),
      status = 'pending',
      sent_at = null,
      delivered_at = null,
      read_at = null,
      synced_at = null,
      retry_count = 0
    } = message;

    this.stmts.insert.run(
      local_id,
      server_id,
      thread_id,
      from_handle,
      to_handle,
      content,
      created_at,
      status,
      sent_at,
      delivered_at,
      read_at,
      synced_at,
      retry_count
    );

    return local_id;
  }

  /**
   * Get messages for a thread between two users
   */
  getThreadMessages(handle1, handle2, limit = 100) {
    return this.stmts.getThread.all(handle1, handle2, handle2, handle1, limit).map(row => ({
      local_id: row.local_id,
      server_id: row.server_id,
      thread_id: row.thread_id,
      from_handle: row.from_handle,
      to_handle: row.to_handle,
      content: row.content,
      created_at: row.created_at,
      status: row.status,
      sent_at: row.sent_at,
      delivered_at: row.delivered_at,
      read_at: row.read_at,
      synced_at: row.synced_at,
      retry_count: row.retry_count
    }));
  }

  /**
   * Update message status after server response
   */
  updateMessageStatus(local_id, status, server_id = null, thread_id = null) {
    const sent_at = status === 'sent' || status === 'delivered' || status === 'read' ? new Date().toISOString() : null;

    this.stmts.updateStatus.run(status, server_id, thread_id, sent_at, local_id);
  }

  /**
   * Merge server messages into local cache (V2 Postgres format)
   * Uses INSERT OR IGNORE to avoid overwriting local changes
   */
  mergeServerMessages(messages) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (local_id, server_id, thread_id, from_handle, to_handle, content, created_at, status,
       sent_at, delivered_at, read_at, synced_at, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(msgs => {
      for (const msg of msgs) {
        insert.run(
          msg.local_id || msg.id || randomUUID(), // Handle both formats
          msg.server_id || msg.id,
          msg.thread_id, // V2 Postgres thread_id
          msg.from_handle || msg.from,
          msg.to_handle || msg.to,
          msg.content || msg.body || msg.text || '',
          msg.created_at || msg.createdAt || new Date().toISOString(),
          msg.status || 'delivered',
          msg.sent_at || msg.sentAt || msg.created_at || msg.createdAt,
          msg.delivered_at || msg.deliveredAt,
          msg.read_at || msg.readAt,
          new Date().toISOString(), // synced_at
          0 // retry_count
        );
      }
    });

    transaction(messages);
    return messages.length;
  }

  /**
   * Get inbox threads for a user
   */
  getInboxThreads(handle) {
    const rows = this.stmts.getInboxThreads.all(
      handle,
      handle,
      handle, // thread_partners CTE
      handle,
      handle,
      handle,
      handle, // latest_messages CTE
      handle,
      handle // unread_counts CTE
    );

    return rows.map(row => ({
      partner: row.partner,
      latestMessage: {
        local_id: row.local_id,
        server_id: row.server_id,
        from_handle: row.from_handle,
        to_handle: row.to_handle,
        content: row.content,
        created_at: row.created_at,
        status: row.status,
        sent_at: row.sent_at,
        delivered_at: row.delivered_at,
        read_at: row.read_at,
        synced_at: row.synced_at,
        retry_count: row.retry_count
      },
      unreadCount: row.unread_count
    }));
  }

  /**
   * Mark all messages in a thread as read
   */
  markThreadRead(my_handle, other_handle) {
    const now = new Date().toISOString();
    const result = this.stmts.markThreadRead.run(now, other_handle, my_handle);
    return result.changes;
  }

  /**
   * Get pending/failed messages for retry
   */
  getPendingMessages() {
    const rows = this.db
      .prepare(
        `
      SELECT local_id, server_id, from_handle, to_handle, content, created_at,
             status, sent_at, delivered_at, read_at, synced_at, retry_count
      FROM messages
      WHERE status = 'pending' OR status = 'failed'
      ORDER BY created_at ASC
    `
      )
      .all();

    return rows.map(row => ({
      local_id: row.local_id,
      server_id: row.server_id,
      from_handle: row.from_handle,
      to_handle: row.to_handle,
      content: row.content,
      created_at: row.created_at,
      status: row.status,
      sent_at: row.sent_at,
      delivered_at: row.delivered_at,
      read_at: row.read_at,
      synced_at: row.synced_at,
      retry_count: row.retry_count
    }));
  }

  close() {
    this.db.close();
  }
}

// Export singleton instance
let instance = null;

function getInstance() {
  if (!instance) {
    try {
      instance = new MessageStore();
    } catch (error) {
      console.error('[SQLite] Failed to initialize:', error.message);
      // Return stub with no-op methods if SQLite fails
      return {
        saveLocalMessage: () => randomUUID(),
        getThreadMessages: () => [],
        updateMessageStatus: () => {},
        mergeServerMessages: () => 0,
        getInboxThreads: () => [],
        markThreadRead: () => 0,
        getPendingMessages: () => [],
        close: () => {}
      };
    }
  }
  return instance;
}

module.exports = getInstance();
