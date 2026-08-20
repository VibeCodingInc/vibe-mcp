/**
 * Shared work context gathering — used by start.js and work-summary.js
 *
 * SECURITY: Uses execFileSync (not execSync) to prevent shell injection.
 * A malicious branch name like "; rm -rf /" would be harmless with this approach.
 *
 * This module provides:
 * - Git state (branch, recent commits, changed files, uncommitted status)
 * - Project detection (package.json, Cargo.toml, pyproject.toml, or directory name)
 * - Auto-generated suggestions for presence and messages
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Sanitization and limits
// ═══════════════════════════════════════════════════════════════════════════

// Strip ANSI escape sequences and control characters (prevent terminal injection)
function sanitize(text) {
  if (!text) return text;
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escape sequences
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control chars (keep \t \n \r)
    .trim();
}

// Character limits (DoS prevention)
const LIMITS = {
  branch: 100,
  commitMessage: 80,
  fileName: 50,
  totalFiles: 10,
  totalSummary: 200,
};

function cap(text, limit) {
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

// Redaction patterns (prevent accidental secret exposure)
const REDACT_PATTERNS = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,  // emails
  /[a-fA-F0-9]{32,}/g,                                  // long hex (tokens, hashes)
  /sk-[a-zA-Z0-9]{20,}/g,                               // OpenAI API keys
  /ghp_[a-zA-Z0-9]{36}/g,                               // GitHub tokens
  /\b(password|secret|token|api_key|apikey)\b/gi,       // sensitive words in context
];

function redact(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// GIT INFO GATHERING (Safe execution)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute git command safely (no shell, with timeout and output limits)
 * @param {string[]} args - Git command arguments (e.g., ['branch', '--show-current'])
 * @returns {string|null} - Command output or null on failure
 */
function safeGitExec(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 2000,           // 2s timeout
      maxBuffer: 100 * 1024,   // 100KB max output
      shell: false,            // CRITICAL: no shell = no injection
      stdio: ['pipe', 'pipe', 'pipe']  // Capture stderr too
    }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Get comprehensive git information for the current directory
 */
function getGitInfo() {
  // Check if we're in a git repo first
  const branch = sanitize(safeGitExec(['branch', '--show-current']));
  if (!branch) {
    // Not a git repo or detached HEAD - try to get commit hash
    const headHash = sanitize(safeGitExec(['rev-parse', '--short', 'HEAD']));
    if (headHash) {
      return {
        branch: `detached:${cap(headHash, 10)}`,
        recentCommits: [],
        changedFiles: [],
        hasUncommitted: false,
        isDetached: true
      };
    }
    return null; // Not a git repo at all
  }

  // Get recent commits (--no-pager prevents interactive mode)
  const logOutput = sanitize(safeGitExec(['--no-pager', 'log', '--oneline', '-3'])) || '';
  const recentCommits = logOutput.split('\n').filter(Boolean).slice(0, 3).map(line => {
    const [hash, ...msg] = line.split(' ');
    return {
      hash: cap(hash, 7),
      message: redact(cap(msg.join(' '), LIMITS.commitMessage))
    };
  });

  // Get changed files (--no-ext-diff --no-textconv prevent custom diff handlers)
  const diffOutput = sanitize(safeGitExec([
    '--no-pager', 'diff', '--no-ext-diff', '--no-textconv',
    '--name-only', 'HEAD~1'
  ])) || '';
  const changedFiles = diffOutput.split('\n')
    .filter(Boolean)
    .slice(0, LIMITS.totalFiles)
    .map(f => cap(path.basename(f), LIMITS.fileName)); // Only basename, not full path

  // Check for uncommitted changes (porcelain = machine-readable, safe)
  const statusOutput = safeGitExec(['status', '--porcelain']);

  return {
    branch: cap(branch, LIMITS.branch),
    recentCommits,
    changedFiles,
    hasUncommitted: !!statusOutput,
    isDetached: false
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT INFO GATHERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect project type and name from manifest files
 */
function getProjectInfo() {
  const cwd = process.cwd();
  const dirName = path.basename(cwd);

  let name = dirName;
  let type = 'unknown';

  // Try package.json (Node.js projects)
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    name = pkg.name || dirName;

    // Detect more specific type
    if (pkg.dependencies?.next || pkg.devDependencies?.next) {
      type = 'nextjs';
    } else if (pkg.dependencies?.react || pkg.devDependencies?.react) {
      type = 'react';
    } else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      type = 'typescript';
    } else {
      type = 'node';
    }
  } catch (e) {}

  // Try Cargo.toml (Rust projects)
  try {
    const cargoPath = path.join(cwd, 'Cargo.toml');
    fs.accessSync(cargoPath);
    type = 'rust';

    // Try to extract crate name
    const cargoContent = fs.readFileSync(cargoPath, 'utf8');
    const nameMatch = cargoContent.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) name = nameMatch[1];
  } catch (e) {}

  // Try pyproject.toml (Python projects)
  try {
    const pyPath = path.join(cwd, 'pyproject.toml');
    fs.accessSync(pyPath);
    type = 'python';

    // Try to extract project name
    const pyContent = fs.readFileSync(pyPath, 'utf8');
    const nameMatch = pyContent.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) name = nameMatch[1];
  } catch (e) {}

  // Try go.mod (Go projects)
  try {
    const goPath = path.join(cwd, 'go.mod');
    const goContent = fs.readFileSync(goPath, 'utf8');
    type = 'go';

    const moduleMatch = goContent.match(/module\s+(\S+)/);
    if (moduleMatch) {
      // Use last part of module path as name
      const parts = moduleMatch[1].split('/');
      name = parts[parts.length - 1];
    }
  } catch (e) {}

  return {
    name: cap(name, 50),
    type,
    directory: cwd
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUGGESTION GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate human-readable summaries of current work
 * @param {object} git - Git info from getGitInfo()
 * @param {object} project - Project info from getProjectInfo()
 * @returns {object} - { brief, detailed }
 */
function generateSuggestions(git, project) {
  const suggestions = {};

  if (git?.branch && !git.isDetached) {
    // We have git context - build meaningful summary
    const branchDesc = ['main', 'master', 'develop'].includes(git.branch) ? '' : ` on ${git.branch}`;

    if (git.recentCommits.length > 0) {
      // Use most recent commit message as the summary
      suggestions.brief = `${git.recentCommits[0].message} — ${project.name}`;
    } else {
      suggestions.brief = `Working on ${project.name}${branchDesc}`;
    }

    // Detailed version includes more context
    const parts = [];
    if (git.recentCommits.length > 0) {
      parts.push(`Just pushed: "${git.recentCommits[0].message}"`);
    }
    if (branchDesc) {
      parts.push(branchDesc.trim());
    }
    if (git.changedFiles.length > 0) {
      // Group by directory for context
      const dirs = [...new Set(git.changedFiles.map(f => {
        const dir = f.split('/')[0];
        return dir === f ? '.' : dir;
      }))];
      const dirsStr = dirs.slice(0, 2).join(', ');
      parts.push(`${git.changedFiles.length} files in ${dirsStr}`);
    }
    if (git.hasUncommitted) {
      parts.push('uncommitted changes');
    }

    suggestions.detailed = parts.join('. ') || suggestions.brief;
  } else if (git?.isDetached) {
    // Detached HEAD state
    suggestions.brief = `Working on ${project.name} (${git.branch})`;
    suggestions.detailed = suggestions.brief;
  } else {
    // No git - just use project info
    suggestions.brief = `Working on ${project.name}`;
    suggestions.detailed = suggestions.brief;
  }

  // Apply final length cap
  suggestions.brief = cap(suggestions.brief, LIMITS.totalSummary);
  suggestions.detailed = cap(suggestions.detailed, LIMITS.totalSummary * 2);

  return suggestions;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gather complete work context - the main entry point
 * Safe, non-blocking, with graceful degradation
 */
function gatherWorkContext() {
  const git = getGitInfo();
  const project = getProjectInfo();
  const suggestions = generateSuggestions(git, project);

  return {
    git,
    project,
    suggestions
  };
}

/**
 * Gather with timeout - for use in start.js where we can't block
 * @param {number} timeoutMs - Maximum time to wait (default 2000ms)
 */
async function gatherWithTimeout(timeoutMs = 2000) {
  return new Promise((resolve) => {
    // Set a timeout that resolves with minimal fallback
    const timer = setTimeout(() => {
      resolve({
        git: null,
        project: { name: path.basename(process.cwd()), type: 'unknown', directory: process.cwd() },
        suggestions: { brief: 'Working locally', detailed: 'Working locally' }
      });
    }, timeoutMs);

    // Try to gather context
    try {
      const context = gatherWorkContext();
      clearTimeout(timer);
      resolve(context);
    } catch (e) {
      clearTimeout(timer);
      resolve({
        git: null,
        project: { name: path.basename(process.cwd()), type: 'unknown', directory: process.cwd() },
        suggestions: { brief: 'Working locally', detailed: 'Working locally' }
      });
    }
  });
}

module.exports = {
  gatherWorkContext,
  gatherWithTimeout,
  getGitInfo,
  getProjectInfo,
  // Exported for testing
  sanitize,
  redact,
  cap
};
