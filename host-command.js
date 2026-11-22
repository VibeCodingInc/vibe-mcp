'use strict';

/**
 * The /vibe command for Claude Code (hosts/vibe-command.md), installed at
 * <claude dir>/commands/vibe.md, or beside a person's own /vibe as
 * vibe-moves.md. The claude dir is CLAUDE_CONFIG_DIR when set, else ~/.claude.
 *
 *   install()  setup's job: writes the command where none exists, or where
 *              the file there is exactly one an earlier release installed.
 *   refresh()  the server's job at every start: ONLY replaces a file that is
 *              exactly one an earlier release installed, so an upgrade reaches
 *              people without running setup again. It never creates one: that
 *              stays the person's act (setup), as it is for the hooks, whose
 *              start-time refresh also never installs.
 *
 * Any other content is the person's own and is never written. A link is never
 * written through. Writes are atomic: a temporary file in the same directory,
 * then a rename.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SOURCE = path.join(__dirname, 'hosts', 'vibe-command.md');
const NAMES = ['vibe.md', 'vibe-moves.md'];

/**
 * The /vibe command exactly as earlier releases shipped it (sha256 of the file
 * as installed: setup wrote hosts/vibe-command.md byte for byte). Up to
 * v0.9.21 every one tells the agent to offer Send in the host's question
 * control. A pick there is not counted as the person's choice, so a Send
 * offered that way is refused.
 * Verified with `git show <tag>:hosts/vibe-command.md | shasum -a 256`; the file
 * did not exist before v0.8.27.
 */
const SHIPPED_COMMAND_SHA256 = new Set([
  '64a842d96794f097e3961273c8b53e71b6d1f50163fd9c81a3289c8a0c223120', // v0.8.27 - v0.8.28
  'a77c53ea7618081476c8080f538d5c915cf855a1d2a78e4805a0374d553f35dc', // v0.9.0
  'eb3f86ac1fcb074a17df920a35690db9dd3896b82215dc3d1eb632742727fa2f', // v0.9.1 - v0.9.8
  '84bfb3ae540ed900a8f0c3e08db244fc2ea1a8474591a968c47a1864f12d8ec4', // v0.9.9 - v0.9.16
  '5c1c767cf52eb6f5650f22f51d9a888c75d2c3a0dfe797cacb5c1fec41b0ea75', // v0.9.17 - v0.9.21
  // v0.9.22 asked in words, but said nothing about a thread's "you": a new
  // session read the person's own earlier message as unexplained.
  '0d1de22e0c970a5ee750c5b5b38fe7e3f25730f00b51aa175ba875c44f5a78df', // v0.9.22
  // v0.9.23 did not tell the agent to keep out of what the person types in
  // the box (0.9.24 asks the person to type the recipient's first letters).
  '36823d773eacc14d7b08bf5796acf7d3c6636b21eb22fc8efab6e7bc55028425', // v0.9.23
]);

function claudeDir(env = process.env) {
  const named = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
  return named || path.join(os.homedir(), '.claude');
}

/** True only for a regular file (not a link) whose bytes are a command this package shipped. */
function isShippedCommand(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return false;
    return SHIPPED_COMMAND_SHA256.has(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  } catch { return false; }
}

function isCurrent(file, body) {
  try { return fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8') === body; } catch { return false; }
}

/**
 * Write `content` to `file` atomically. `expect` is what must be there right
 * before the rename: 'absent', or 'shipped' (a regular file an earlier release
 * wrote). Anything else there, a link included, and nothing is written.
 */
function atomicWrite(file, content, expect) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    let ok;
    if (expect === 'absent') {
      try { fs.lstatSync(file); ok = false; } catch (e) { ok = e && e.code === 'ENOENT'; }
    } else {
      ok = isShippedCommand(file);
    }
    if (!ok) { fs.unlinkSync(tmp); return false; }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function readBody() {
  try { return fs.readFileSync(SOURCE, 'utf8'); } catch { return null; }
}

/**
 * Setup: install the command. Returns [{ host, path, replaced? } | { host, path, error }].
 * A person's own /vibe (command or skill) is never overwritten: when it
 * exists, the command installs beside it as /vibe-moves and says so.
 */
function install(env = process.env) {
  const body = readBody();
  if (body === null) return [];
  const dir = claudeDir(env);
  if (!fs.existsSync(dir)) return [];
  const own = path.join(dir, 'commands', 'vibe.md');
  // A command an earlier release installed, or the current one, is ours.
  const ours = (f) => isCurrent(f, body) || isShippedCommand(f);
  const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
  const taken = fs.existsSync(path.join(dir, 'skills', 'vibe', 'SKILL.md')) || (exists(own) && !ours(own));
  const file = path.join(dir, 'commands', taken ? 'vibe-moves.md' : 'vibe.md');
  try {
    const there = exists(file);
    if (there && (isCurrent(file, body) || !isShippedCommand(file))) return [];
    if (!atomicWrite(file, body, there ? 'shipped' : 'absent')) return [];
    return [{ host: 'Claude Code', path: file, ...(there ? { replaced: true } : {}) }];
  } catch (e) {
    return [{ host: 'Claude Code', path: file, error: e && e.message ? e.message : String(e) }];
  }
}

/** Server start: replace each installed command that is exactly an earlier release's. Never creates one. Never throws. */
function refresh(env = process.env) {
  const replaced = [];
  try {
    const body = readBody();
    if (body === null) return replaced;
    for (const name of NAMES) {
      const file = path.join(claudeDir(env), 'commands', name);
      try { if (isShippedCommand(file) && atomicWrite(file, body, 'shipped')) replaced.push(file); } catch {}
    }
  } catch {}
  return replaced;
}

module.exports = { SHIPPED_COMMAND_SHA256, isShippedCommand, claudeDir, install, refresh };
