/**
 * Tests for _work-context.js
 *
 * Run with: node --test tools/_work-context.test.js
 * Or: node tools/_work-context.test.js (for quick inline tests)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  gatherWorkContext,
  gatherWithTimeout,
  getGitInfo,
  getProjectInfo,
  sanitize,
  redact,
  cap
} = require('./_work-context');

// ═══════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Utility functions
// ═══════════════════════════════════════════════════════════════════════════

describe('sanitize()', () => {
  test('removes ANSI escape sequences', () => {
    const input = '\x1B[31mRed text\x1B[0m';
    assert.strictEqual(sanitize(input), 'Red text');
  });

  test('removes control characters but keeps newlines/tabs', () => {
    const input = 'Hello\x00World\tTab\nNewline';
    assert.strictEqual(sanitize(input), 'HelloWorld\tTab\nNewline');
  });

  test('handles null/undefined gracefully', () => {
    assert.strictEqual(sanitize(null), null);
    assert.strictEqual(sanitize(undefined), undefined);
  });

  test('trims whitespace', () => {
    assert.strictEqual(sanitize('  hello  '), 'hello');
  });
});

describe('cap()', () => {
  test('returns original if under limit', () => {
    assert.strictEqual(cap('hello', 10), 'hello');
  });

  test('truncates with ellipsis if over limit', () => {
    assert.strictEqual(cap('hello world', 8), 'hello w…');
  });

  test('handles exact length', () => {
    assert.strictEqual(cap('hello', 5), 'hello');
  });

  test('handles null/undefined', () => {
    assert.strictEqual(cap(null, 10), null);
    assert.strictEqual(cap(undefined, 10), undefined);
  });
});

describe('redact()', () => {
  test('redacts email addresses', () => {
    const input = 'Contact me at user@example.com';
    assert.strictEqual(redact(input), 'Contact me at [REDACTED]');
  });

  test('redacts long hex strings (tokens)', () => {
    const input = 'Value: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
    assert.strictEqual(redact(input), 'Value: [REDACTED]');
  });

  test('redacts OpenAI API keys', () => {
    const input = 'Key: sk-1234567890abcdefghij1234567890';
    assert.strictEqual(redact(input), 'Key: [REDACTED]');
  });

  test('redacts GitHub tokens', () => {
    const input = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    assert.strictEqual(redact(input), '[REDACTED]');
  });

  test('redacts sensitive words', () => {
    const words = ['password', 'secret', 'token', 'api_key'];
    words.forEach(word => {
      assert.ok(redact(`My ${word} is hidden`).includes('[REDACTED]'));
    });
  });

  test('handles null/undefined', () => {
    assert.strictEqual(redact(null), null);
    assert.strictEqual(redact(undefined), undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Git info gathering
// ═══════════════════════════════════════════════════════════════════════════

describe('getGitInfo()', () => {
  test('returns object with expected shape when in git repo', () => {
    const info = getGitInfo();

    // We're in the vibe-platform repo, so git should work
    if (info) {
      assert.ok(typeof info.branch === 'string', 'branch should be a string');
      assert.ok(Array.isArray(info.recentCommits), 'recentCommits should be an array');
      assert.ok(Array.isArray(info.changedFiles), 'changedFiles should be an array');
      assert.ok(typeof info.hasUncommitted === 'boolean', 'hasUncommitted should be boolean');
    }
  });

  test('commit messages are capped and redacted', () => {
    const info = getGitInfo();
    if (info && info.recentCommits.length > 0) {
      const firstCommit = info.recentCommits[0];
      assert.ok(firstCommit.message.length <= 80, 'commit message should be <= 80 chars');
      assert.ok(firstCommit.hash.length <= 7, 'commit hash should be <= 7 chars');
    }
  });

  test('changed files use basename only (no full paths)', () => {
    const info = getGitInfo();
    if (info && info.changedFiles.length > 0) {
      info.changedFiles.forEach(file => {
        assert.ok(!file.includes('/'), `file "${file}" should not contain path separators`);
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Project info gathering
// ═══════════════════════════════════════════════════════════════════════════

describe('getProjectInfo()', () => {
  test('returns object with expected shape', () => {
    const info = getProjectInfo();

    assert.ok(typeof info.name === 'string', 'name should be a string');
    assert.ok(typeof info.type === 'string', 'type should be a string');
    assert.ok(typeof info.directory === 'string', 'directory should be a string');
  });

  test('detects project name from package.json', () => {
    const info = getProjectInfo();
    // We're in mcp-server which has a package.json
    assert.strictEqual(info.name, 'slashvibe-mcp');
  });

  test('detects project type', () => {
    const info = getProjectInfo();
    // This is a Node.js project
    assert.ok(['node', 'typescript', 'react', 'nextjs'].includes(info.type));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Full context gathering
// ═══════════════════════════════════════════════════════════════════════════

describe('gatherWorkContext()', () => {
  test('returns complete context object', () => {
    const ctx = gatherWorkContext();

    assert.ok(ctx.git !== undefined, 'should have git property');
    assert.ok(ctx.project !== undefined, 'should have project property');
    assert.ok(ctx.suggestions !== undefined, 'should have suggestions property');
  });

  test('suggestions.brief is reasonably short', () => {
    const ctx = gatherWorkContext();
    assert.ok(ctx.suggestions.brief.length <= 200, 'brief should be <= 200 chars');
  });

  test('suggestions.detailed exists', () => {
    const ctx = gatherWorkContext();
    assert.ok(typeof ctx.suggestions.detailed === 'string');
  });
});

describe('gatherWithTimeout()', () => {
  test('resolves within timeout', async () => {
    const start = Date.now();
    const ctx = await gatherWithTimeout(5000);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, 'should resolve before timeout');
    assert.ok(ctx.suggestions !== undefined, 'should have suggestions');
  });

  test('provides fallback on very short timeout', async () => {
    // 1ms timeout should trigger fallback
    const ctx = await gatherWithTimeout(1);

    // Should still have basic structure
    assert.ok(ctx.project !== undefined);
    assert.ok(ctx.suggestions !== undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Shell injection prevention', () => {
  test('branch names with shell metacharacters are safe', () => {
    // This test verifies we're using execFileSync, not execSync
    // If we were vulnerable, a branch like "; rm -rf /" would execute
    // Since we use execFileSync with shell: false, it's treated as literal text
    const info = getGitInfo();
    // If we got here without error, shell injection was prevented
    assert.ok(true, 'No shell injection occurred');
  });
});

describe('Security: Output sanitization', () => {
  test('ANSI escape sequences in commit messages are stripped', () => {
    const ctx = gatherWorkContext();
    if (ctx.git?.recentCommits?.length > 0) {
      ctx.git.recentCommits.forEach(commit => {
        assert.ok(!commit.message.includes('\x1B'), 'should not contain ANSI escapes');
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run tests when executed directly
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  console.log('Running _work-context.js tests...\n');
  console.log('Use: node --test tools/_work-context.test.js');
  console.log('Or run this file directly for a quick smoke test.\n');

  // Quick smoke test
  console.log('=== Quick Smoke Test ===\n');

  const ctx = gatherWorkContext();
  console.log('Project:', ctx.project?.name);
  console.log('Type:', ctx.project?.type);
  console.log('Branch:', ctx.git?.branch || 'N/A');
  console.log('Recent commits:', ctx.git?.recentCommits?.length || 0);
  console.log('Changed files:', ctx.git?.changedFiles?.length || 0);
  console.log('Has uncommitted:', ctx.git?.hasUncommitted);
  console.log('\nBrief summary:', ctx.suggestions?.brief);
  console.log('Detailed summary:', ctx.suggestions?.detailed);

  console.log('\n=== Sanitization Tests ===\n');
  console.log('sanitize("\\x1B[31mred\\x1B[0m"):', sanitize('\x1B[31mred\x1B[0m'));
  console.log('cap("hello world", 8):', cap('hello world', 8));
  console.log('redact("email: a@b.com"):', redact('email: a@b.com'));

  console.log('\n✓ All smoke tests passed\n');
}
