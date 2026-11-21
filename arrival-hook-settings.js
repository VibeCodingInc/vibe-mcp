'use strict';

/**
 * Installs the arrival hook (hooks/arrival-hook.cjs) into Claude Code.
 *
 * Two things, both reversible:
 *   1. a COPY of the script at <VIBE_HOME>/hooks/arrival-hook.cjs — the hook
 *      runs on every prompt and after tool calls, so its command must be a
 *      plain `node <file>`, never an npx launch;
 *   2. one owned handler under UserPromptSubmit and one under PostToolUse in
 *      ~/.claude/settings.json. Ownership is by the script's filename, so an
 *      upgrade or a moved node binary replaces our entry and nothing else.
 *
 * Everything else in the settings file is preserved byte-for-value, through
 * the same read/validate/atomic-write path the SessionStart hook uses.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { vibeHome } = require('./vibe-home');
const { HookSettingsError, atomicWrite, readSettings, settingsPath } = require('./session-start-hook-settings');

const EVENTS = ['UserPromptSubmit', 'PostToolUse'];
const SCRIPT_NAME = 'arrival-hook.cjs';
const TIMEOUT_SECONDS = 5;
const SOURCE = path.join(__dirname, 'hooks', SCRIPT_NAME);
const PACKAGE_VERSION = require('./package.json').version;

function scriptPath(env = process.env) {
  return path.join(vibeHome(env), 'hooks', SCRIPT_NAME);
}

function quote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * The node binary to name in the hook command. process.execPath is the REAL
 * path, which under Homebrew is a versioned Cellar directory that disappears
 * on the next `brew upgrade` — the hook would then fail on every prompt. Prefer
 * a PATH entry that currently resolves to this same binary (e.g.
 * /opt/homebrew/bin/node): it survives upgrades.
 */
function stableNode(env = process.env, fileSystem = fs, execPath = process.execPath) {
  let real;
  try { real = fileSystem.realpathSync(execPath); } catch { return execPath; }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try { if (candidate !== real && fileSystem.realpathSync(candidate) === real) return candidate; } catch {}
  }
  return execPath;
}

function hookCommand(env = process.env, node = stableNode(env)) {
  return `${quote(node)} ${quote(scriptPath(env))}`;
}

/** Ours = a command handler that runs OUR script from THIS identity directory. */
function owned(handler, env = process.env) {
  return Boolean(
    handler && typeof handler === 'object' && handler.type === 'command' &&
    typeof handler.command === 'string' && handler.command.includes(scriptPath(env))
  );
}

function validate(settings) {
  if (settings.hooks !== undefined &&
      (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new HookSettingsError('claude_hooks_invalid');
  }
  for (const event of EVENTS) {
    if (settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event])) {
      throw new HookSettingsError('claude_hooks_invalid');
    }
  }
}

function without(settings, env) {
  validate(settings);
  let removed = 0;
  const hooks = { ...(settings.hooks || {}) };
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event].flatMap((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return [group];
      const kept = group.hooks.filter((h) => { if (!owned(h, env)) return true; removed += 1; return false; });
      return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
    });
    if (groups.length === 0) delete hooks[event]; else hooks[event] = groups;
  }
  if (removed === 0) return { settings, removed };
  const next = { ...settings };
  if (Object.keys(hooks).length === 0) delete next.hooks; else next.hooks = hooks;
  return { settings: next, removed };
}

function withEntry(settings, env, node) {
  const base = without(settings, env).settings;
  const hooks = { ...(base.hooks || {}) };
  for (const event of EVENTS) {
    hooks[event] = [...(hooks[event] || []), {
      hooks: [{ type: 'command', command: hookCommand(env, node), timeout: TIMEOUT_SECONDS }],
    }];
  }
  const next = { ...base, hooks };
  return { settings: next, changed: JSON.stringify(settings) !== JSON.stringify(next) };
}

/** The package version that wrote the installed copy: <script>.version beside it. */
function versionPath(env = process.env) {
  return `${scriptPath(env)}.version`;
}

/** -1, 0, 1 for dotted numeric versions; anything unparseable sorts lowest. */
function compareVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a); const y = parse(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Copy the script into place when missing or different. Returns true if
 * written. FORWARD ONLY: a copy written by a newer package version is left
 * alone, so an older server still running (another session, a pinned npx)
 * cannot put back a hook a newer release replaced. A copy with no recorded
 * version predates the record and is treated as older.
 */
function syncScript(env = process.env, fileSystem = fs, version = PACKAGE_VERSION) {
  const target = scriptPath(env);
  const source = fileSystem.readFileSync(SOURCE);
  try { if (fileSystem.readFileSync(target).equals(source)) return false; } catch {}
  let installed = null;
  try { installed = JSON.parse(fileSystem.readFileSync(versionPath(env), 'utf8')).version; } catch {}
  if (installed !== null && compareVersions(installed, version) > 0) return false;
  fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // The version first: interrupted between the two writes, the next start of
  // this version or newer finishes the copy.
  const vtmp = `${versionPath(env)}.${process.pid}.tmp`;
  fileSystem.writeFileSync(vtmp, JSON.stringify({ version }), { mode: 0o600 });
  fileSystem.renameSync(vtmp, versionPath(env));
  const tmp = `${target}.${process.pid}.tmp`;
  fileSystem.writeFileSync(tmp, source, { mode: 0o700 });
  fileSystem.renameSync(tmp, target);
  return true;
}

function createArrivalHookManager(options = {}) {
  const env = options.env || process.env;
  const fileSystem = options.fs || fs;
  const node = options.node || stableNode(env, fileSystem);
  const target = options.settingsPath || settingsPath(env);

  function status() {
    const current = readSettings(target, fileSystem);
    validate(current.settings);
    const events = EVENTS.filter((event) =>
      (current.settings.hooks?.[event] || []).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => owned(h, env))));
    return { installed: events.length === EVENTS.length, events, path: target, script: scriptPath(env) };
  }

  function install() {
    syncScript(env, fileSystem);
    const current = readSettings(target, fileSystem);
    const next = withEntry(current.settings, env, node);
    if (next.changed) atomicWrite(target, next.settings, current.mode, fileSystem, options.randomUUID || crypto.randomUUID);
    return { ...status(), changed: next.changed };
  }

  function uninstall() {
    const current = readSettings(target, fileSystem);
    const next = without(current.settings, env);
    if (next.removed > 0) atomicWrite(target, next.settings, current.mode, fileSystem, options.randomUUID || crypto.randomUUID);
    try { fileSystem.unlinkSync(scriptPath(env)); } catch {}
    try { fileSystem.unlinkSync(versionPath(env)); } catch {}
    return { ...status(), changed: next.removed > 0, removed: next.removed };
  }

  /** Keep an INSTALLED hook's script current after an upgrade; never installs. */
  function refresh() {
    try {
      if (!status().installed) return false;
      const wrote = syncScript(env, fileSystem);
      // Repair, never install: if the node binary our entry names is gone
      // (an upgrade removed it), rewrite OUR entry with one that exists.
      const current = readSettings(target, fileSystem);
      const dead = EVENTS.some((event) => (current.settings.hooks?.[event] || []).some((g) =>
        Array.isArray(g?.hooks) && g.hooks.some((h) => {
          if (!owned(h, env)) return false;
          const named = (h.command.match(/^"((?:[^"\\]|\\.)*)"/) || [])[1];
          return Boolean(named) && !fileSystem.existsSync(named.replace(/\\(.)/g, '$1'));
        })));
      if (dead) install();
      return wrote || dead;
    } catch {}
    return false;
  }

  return { install, uninstall, status, refresh };
}

module.exports = { EVENTS, SCRIPT_NAME, createArrivalHookManager, hookCommand, scriptPath, versionPath, compareVersions, stableNode, syncScript };
