const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');

// ── getApiUrl ──

describe('getApiUrl', () => {
  it('returns default URL when env not set', () => {
    const original = process.env.VIBE_API_URL;
    delete process.env.VIBE_API_URL;
    assert.equal(config.getApiUrl(), 'https://www.slashvibe.dev');
    // Restore
    if (original) process.env.VIBE_API_URL = original;
  });

  it('returns env override when set', () => {
    const original = process.env.VIBE_API_URL;
    process.env.VIBE_API_URL = 'http://localhost:3000';
    assert.equal(config.getApiUrl(), 'http://localhost:3000');
    // Restore
    if (original) {
      process.env.VIBE_API_URL = original;
    } else {
      delete process.env.VIBE_API_URL;
    }
  });
});

// ── generateSessionId ──

describe('generateSessionId', () => {
  it('starts with sess_ prefix', () => {
    const id = config.generateSessionId();
    assert.ok(id.startsWith('sess_'), `Expected sess_ prefix, got: ${id}`);
  });

  it('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(config.generateSessionId());
    }
    assert.equal(ids.size, 100, 'Generated duplicate session IDs');
  });
});

// ── Ephemeral session state (get/set) ──

describe('ephemeral session state', () => {
  it('returns default for unset key', () => {
    assert.equal(config.get('__test_nonexistent__'), null);
    assert.equal(config.get('__test_nonexistent__', 42), 42);
  });

  it('stores and retrieves values', () => {
    config.set('__test_key__', 'hello');
    assert.equal(config.get('__test_key__'), 'hello');
  });

  it('overwrites existing values', () => {
    config.set('__test_overwrite__', 'first');
    config.set('__test_overwrite__', 'second');
    assert.equal(config.get('__test_overwrite__'), 'second');
  });

  it('supports different value types', () => {
    config.set('__test_num__', 123);
    config.set('__test_bool__', false);
    config.set('__test_arr__', [1, 2, 3]);
    config.set('__test_obj__', { a: 1 });

    assert.equal(config.get('__test_num__'), 123);
    assert.equal(config.get('__test_bool__'), false);
    assert.deepEqual(config.get('__test_arr__'), [1, 2, 3]);
    assert.deepEqual(config.get('__test_obj__'), { a: 1 });
  });
});

// ── Notification validation ──

describe('notification levels', () => {
  it('rejects invalid notification level', () => {
    assert.throws(() => config.setNotifications('invalid'), {
      message: /Invalid notification level/
    });
  });
});

// ── GitHub activity privacy validation ──

describe('github activity privacy', () => {
  it('rejects invalid privacy level', () => {
    assert.throws(() => config.setGithubActivityPrivacy('invalid'), {
      message: /Invalid privacy level/
    });
  });
});
