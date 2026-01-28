#!/usr/bin/env node
/**
 * V2 Postgres Integration Test Suite
 *
 * Tests the complete message flow:
 * 1. SQLite schema validation
 * 2. Message saving (optimistic UI)
 * 3. thread_id extraction from V2 API
 * 4. Message status updates
 * 5. Thread retrieval
 *
 * Run: node test-v2-integration.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const sqlite = require('./store/sqlite');

const DB_PATH = path.join(os.homedir(), '.vibecodings', 'sessions.db');

class V2IntegrationTest {
  constructor() {
    this.db = new Database(DB_PATH);
    this.results = {
      passed: [],
      failed: [],
      warnings: []
    };
  }

  log(emoji, message) {
    console.log(`${emoji} ${message}`);
  }

  pass(test, details = '') {
    this.results.passed.push({ test, details });
    this.log('✅', `${test}${details ? ': ' + details : ''}`);
  }

  fail(test, error) {
    this.results.failed.push({ test, error });
    this.log('❌', `${test}: ${error}`);
  }

  warn(test, message) {
    this.results.warnings.push({ test, message });
    this.log('⚠️', `${test}: ${message}`);
  }

  // Test 1: Schema Validation
  testSchema() {
    this.log('🔍', 'Test 1: Validating SQLite schema...');

    const columns = this.db.prepare('PRAGMA table_info(messages)').all();
    const columnNames = columns.map(c => c.name);

    const requiredColumns = [
      'local_id',
      'server_id',
      'thread_id', // V2 requirement
      'from_handle',
      'to_handle',
      'content',
      'created_at',
      'status',
      'sent_at',
      'delivered_at',
      'read_at',
      'synced_at',
      'retry_count'
    ];

    const missing = requiredColumns.filter(col => !columnNames.includes(col));

    if (missing.length > 0) {
      this.fail('Schema validation', `Missing columns: ${missing.join(', ')}`);
      return false;
    }

    this.pass('Schema validation', `All ${requiredColumns.length} columns present`);

    // Check indexes
    const indexes = this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all();
    const indexNames = indexes.map(i => i.name);

    if (!indexNames.includes('idx_messages_thread_id')) {
      this.warn('Index check', 'idx_messages_thread_id missing');
    } else {
      this.pass('Index check', 'thread_id index exists');
    }

    return true;
  }

  // Test 2: Message Saving (Optimistic UI)
  testMessageSaving() {
    this.log('🔍', 'Test 2: Testing optimistic message save...');

    const testMessage = {
      from_handle: 'test_alice',
      to_handle: 'test_bob',
      content: 'Test message for V2 integration',
      status: 'pending'
    };

    try {
      const local_id = sqlite.saveLocalMessage(testMessage);

      if (!local_id) {
        this.fail('Message saving', 'No local_id returned');
        return null;
      }

      // Verify it was saved
      const saved = this.db.prepare('SELECT * FROM messages WHERE local_id = ?').get(local_id);

      if (!saved) {
        this.fail('Message saving', 'Message not found after save');
        return null;
      }

      if (saved.status !== 'pending') {
        this.fail('Message saving', `Expected status 'pending', got '${saved.status}'`);
        return null;
      }

      this.pass('Message saving', `Saved with local_id: ${local_id.slice(0, 12)}...`);
      return local_id;
    } catch (error) {
      this.fail('Message saving', error.message);
      return null;
    }
  }

  // Test 3: Status Update with thread_id
  testStatusUpdate(local_id) {
    if (!local_id) {
      this.warn('Status update', 'Skipped (no local_id from previous test)');
      return;
    }

    this.log('🔍', 'Test 3: Testing status update with thread_id...');

    try {
      // Simulate V2 API response with server_id and thread_id
      const server_id = 'msg_test_' + Date.now();
      const thread_id = 'thread_test_' + Date.now();

      sqlite.updateMessageStatus(local_id, 'sent', server_id, thread_id);

      // Verify update
      const updated = this.db.prepare('SELECT * FROM messages WHERE local_id = ?').get(local_id);

      if (updated.status !== 'sent') {
        this.fail('Status update', `Expected status 'sent', got '${updated.status}'`);
        return;
      }

      if (updated.server_id !== server_id) {
        this.fail('Status update', `server_id mismatch`);
        return;
      }

      if (updated.thread_id !== thread_id) {
        this.fail('Status update', `thread_id not saved correctly`);
        return;
      }

      if (!updated.sent_at) {
        this.warn('Status update', 'sent_at timestamp not set');
      }

      this.pass('Status update', `Status: ${updated.status}, thread_id: ${thread_id.slice(0, 20)}...`);
    } catch (error) {
      this.fail('Status update', error.message);
    }
  }

  // Test 4: Thread Retrieval
  testThreadRetrieval() {
    this.log('🔍', 'Test 4: Testing thread retrieval...');

    try {
      const messages = sqlite.getThreadMessages('test_alice', 'test_bob', 100);

      if (!Array.isArray(messages)) {
        this.fail('Thread retrieval', 'Did not return an array');
        return;
      }

      if (messages.length === 0) {
        this.warn('Thread retrieval', 'No messages found (expected from test 2)');
        return;
      }

      const msg = messages[0];

      // Check that thread_id is included
      if (msg.thread_id === undefined) {
        this.fail('Thread retrieval', 'Message missing thread_id field');
        return;
      }

      this.pass('Thread retrieval', `Retrieved ${messages.length} message(s) with thread_id`);
    } catch (error) {
      this.fail('Thread retrieval', error.message);
    }
  }

  // Test 5: Merge Server Messages (V2 format)
  testMergeServerMessages() {
    this.log('🔍', 'Test 5: Testing server message merge with V2 format...');

    const v2Messages = [
      {
        id: 'msg_server_001',
        thread_id: 'thread_xyz',
        from: 'server_alice',
        to: 'server_bob',
        body: 'Server message 1',
        created_at: new Date().toISOString()
      },
      {
        id: 'msg_server_002',
        thread_id: 'thread_xyz',
        from: 'server_bob',
        to: 'server_alice',
        body: 'Server message 2',
        created_at: new Date().toISOString()
      }
    ];

    try {
      const merged = sqlite.mergeServerMessages(v2Messages);

      if (merged !== v2Messages.length) {
        this.fail('Server message merge', `Expected ${v2Messages.length} merged, got ${merged}`);
        return;
      }

      // Verify messages were saved with thread_id
      const saved = this.db
        .prepare(
          `
        SELECT * FROM messages
        WHERE server_id IN ('msg_server_001', 'msg_server_002')
        ORDER BY created_at
      `
        )
        .all();

      if (saved.length !== 2) {
        this.fail('Server message merge', `Expected 2 messages, found ${saved.length}`);
        return;
      }

      // Check thread_id was preserved
      const threadIds = saved.map(m => m.thread_id);
      if (!threadIds.every(id => id === 'thread_xyz')) {
        this.fail('Server message merge', 'thread_id not preserved correctly');
        return;
      }

      this.pass('Server message merge', `Merged ${merged} V2 messages with thread_id`);
    } catch (error) {
      this.fail('Server message merge', error.message);
    }
  }

  // Test 6: Code Review - Check api.js integration
  testCodeIntegration() {
    this.log('🔍', 'Test 6: Code integration check...');

    const apiCode = require('fs').readFileSync('./store/api.js', 'utf-8');

    // Check 1: sendMessage saves to SQLite
    if (!apiCode.includes('sqlite.saveLocalMessage')) {
      this.fail('Code integration', 'api.js missing sqlite.saveLocalMessage call');
      return;
    }

    // Check 2: sendMessage updates status with thread_id
    if (!apiCode.includes('sqlite.updateMessageStatus')) {
      this.fail('Code integration', 'api.js missing sqlite.updateMessageStatus call');
      return;
    }

    // Check 3: thread_id extraction from V2 response
    if (!apiCode.includes('thread_id')) {
      this.fail('Code integration', 'api.js not extracting thread_id from response');
      return;
    }

    // Check 4: getThread uses sqlite
    if (!apiCode.includes('sqlite.getThreadMessages')) {
      this.fail('Code integration', 'api.js getThread not using SQLite');
      return;
    }

    // Check 5: getInbox uses sqlite
    if (!apiCode.includes('sqlite.getInboxThreads')) {
      this.warn('Code integration', 'api.js getInbox might not be using SQLite optimally');
    }

    this.pass('Code integration', 'All critical V2 integration points found in api.js');
  }

  // Cleanup test data
  cleanup() {
    this.log('🧹', 'Cleaning up test data...');

    try {
      this.db.exec(`
        DELETE FROM messages
        WHERE from_handle LIKE 'test_%'
           OR from_handle LIKE 'server_%'
           OR to_handle LIKE 'test_%'
           OR to_handle LIKE 'server_%'
      `);
      this.pass('Cleanup', 'Test data removed');
    } catch (error) {
      this.warn('Cleanup', error.message);
    }
  }

  // Run all tests
  async runAll() {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('       V2 Postgres Integration Test Suite');
    console.log('════════════════════════════════════════════════════════\n');

    // Run tests
    const schemaOk = this.testSchema();

    if (schemaOk) {
      const local_id = this.testMessageSaving();
      this.testStatusUpdate(local_id);
      this.testThreadRetrieval();
      this.testMergeServerMessages();
    }

    this.testCodeIntegration();
    this.cleanup();

    // Print summary
    console.log('\n════════════════════════════════════════════════════════');
    console.log('                   Test Summary');
    console.log('════════════════════════════════════════════════════════\n');

    console.log(`✅ Passed:   ${this.results.passed.length}`);
    console.log(`❌ Failed:   ${this.results.failed.length}`);
    console.log(`⚠️  Warnings: ${this.results.warnings.length}`);

    if (this.results.failed.length > 0) {
      console.log('\n❌ Failed Tests:');
      this.results.failed.forEach(({ test, error }) => {
        console.log(`   - ${test}: ${error}`);
      });
    }

    if (this.results.warnings.length > 0) {
      console.log('\n⚠️  Warnings:');
      this.results.warnings.forEach(({ test, message }) => {
        console.log(`   - ${test}: ${message}`);
      });
    }

    console.log('\n════════════════════════════════════════════════════════\n');

    // Close database
    this.db.close();

    // Exit with appropriate code
    process.exit(this.results.failed.length > 0 ? 1 : 0);
  }
}

// Run tests
if (require.main === module) {
  const test = new V2IntegrationTest();
  test.runAll();
}

module.exports = V2IntegrationTest;
