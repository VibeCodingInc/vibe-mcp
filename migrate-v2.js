#!/usr/bin/env node
/**
 * Migration: Add thread_id column for V2 Postgres integration
 *
 * This migration adds the thread_id column to the messages table
 * and creates the necessary index for V2 API compatibility.
 *
 * Run: node migrate-v2.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.vibecodings', 'sessions.db');

function migrate() {
  console.log('[Migration] Starting V2 schema migration...');
  console.log(`[Migration] Database: ${DB_PATH}`);

  const db = new Database(DB_PATH);

  // Check if thread_id column already exists
  const columns = db.prepare('PRAGMA table_info(messages)').all();
  const hasThreadId = columns.some(col => col.name === 'thread_id');

  if (hasThreadId) {
    console.log('[Migration] ✅ thread_id column already exists. No migration needed.');
    db.close();
    return;
  }

  console.log('[Migration] Adding thread_id column...');

  try {
    // Add thread_id column
    db.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT;`);

    // Create index for thread_id
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id
      ON messages(thread_id);
    `);

    console.log('[Migration] ✅ Successfully added thread_id column and index');

    // Verify migration
    const newColumns = db.prepare('PRAGMA table_info(messages)').all();
    const threadIdColumn = newColumns.find(col => col.name === 'thread_id');

    if (threadIdColumn) {
      console.log('[Migration] ✅ Verification passed');
      console.log(`[Migration] Column details: ${JSON.stringify(threadIdColumn)}`);
    } else {
      console.error('[Migration] ❌ Verification failed - column not found after migration');
    }
  } catch (error) {
    console.error('[Migration] ❌ Migration failed:', error.message);
    throw error;
  } finally {
    db.close();
  }

  console.log('[Migration] Complete!');
}

// Run migration
if (require.main === module) {
  migrate();
}

module.exports = { migrate };
