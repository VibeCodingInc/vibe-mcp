const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHandle,
  displayHandle,
  formatTimeAgo,
  formatDuration,
  truncate,
  validateRequired,
  header,
  divider,
  emptyState,
  success,
  warning,
  error
} = require('../tools/_shared');

// ── normalizeHandle ──

describe('normalizeHandle', () => {
  it('lowercases and strips @', () => {
    assert.equal(normalizeHandle('@Alice'), 'alice');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeHandle('  bob  '), 'bob');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeHandle(null), '');
    assert.equal(normalizeHandle(undefined), '');
    assert.equal(normalizeHandle(''), '');
  });

  it('handles already-normalized input', () => {
    assert.equal(normalizeHandle('carol'), 'carol');
  });
});

// ── displayHandle ──

describe('displayHandle', () => {
  it('prepends @ to normalized handle', () => {
    assert.equal(displayHandle('Alice'), '@alice');
    assert.equal(displayHandle('@Bob'), '@bob');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(displayHandle(null), '');
    assert.equal(displayHandle(''), '');
  });
});

// ── formatTimeAgo ──

describe('formatTimeAgo', () => {
  it('returns "just now" for recent timestamps', () => {
    assert.equal(formatTimeAgo(Date.now()), 'just now');
    assert.equal(formatTimeAgo(Date.now() - 30000), 'just now');
  });

  it('returns minutes ago', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    assert.equal(formatTimeAgo(fiveMinAgo), '5m ago');
  });

  it('returns hours ago', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    assert.equal(formatTimeAgo(twoHoursAgo), '2h ago');
  });

  it('returns days ago', () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    assert.equal(formatTimeAgo(threeDaysAgo), '3d ago');
  });

  it('handles null/undefined', () => {
    assert.equal(formatTimeAgo(null), 'unknown');
    assert.equal(formatTimeAgo(undefined), 'unknown');
  });

  it('handles ISO string input', () => {
    const result = formatTimeAgo(new Date().toISOString());
    assert.equal(result, 'just now');
  });
});

// ── formatDuration ──

describe('formatDuration', () => {
  it('formats seconds', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(45000), '45s');
  });

  it('formats minutes', () => {
    assert.equal(formatDuration(120000), '2m');
    assert.equal(formatDuration(3000000), '50m');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatDuration(3600000), '1h 0m');
    assert.equal(formatDuration(5400000), '1h 30m');
  });
});

// ── truncate ──

describe('truncate', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncate('hello', 10), 'hello');
  });

  it('truncates long text with ellipsis', () => {
    assert.equal(truncate('hello world', 5), 'hello...');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(truncate(null), '');
    assert.equal(truncate(''), '');
  });

  it('uses default maxLength of 100', () => {
    const longText = 'a'.repeat(150);
    const result = truncate(longText);
    assert.equal(result.length, 103); // 100 + '...'
  });
});

// ── validateRequired ──

describe('validateRequired', () => {
  it('returns null when all fields present', () => {
    assert.equal(validateRequired({ name: 'alice', age: 25 }, ['name', 'age']), null);
  });

  it('returns error display when field missing', () => {
    const result = validateRequired({ name: 'alice' }, ['name', 'email']);
    assert.ok(result);
    assert.ok(result.display.includes('email'));
  });
});

// ── Display helpers ──

describe('display helpers', () => {
  it('header creates markdown header', () => {
    assert.equal(header('Test'), '## Test');
    assert.equal(header('Test', 3), '### Test');
  });

  it('divider creates markdown divider', () => {
    assert.ok(divider().includes('---'));
  });

  it('emptyState formats italic message', () => {
    assert.ok(emptyState('No items').includes('_No items_'));
  });

  it('emptyState includes hint when provided', () => {
    const result = emptyState('No items', 'Try adding one');
    assert.ok(result.includes('Try adding one'));
  });

  it('success formats with checkmark', () => {
    assert.ok(success('Done').includes('Done'));
    assert.ok(success('Created', 'file.js').includes('**file.js**'));
  });

  it('warning formats message', () => {
    assert.ok(warning('Careful').includes('Careful'));
  });

  it('error formats message', () => {
    assert.ok(error('Failed').includes('Failed'));
  });
});
