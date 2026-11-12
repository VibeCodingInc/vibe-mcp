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

/** Copy the script into place when missing or different. Returns true if written. */
function syncScript(env = process.env, fileSystem = fs) {
  const target = scriptPath(env);
  const source = fileSystem.readFileSync(SOURCE);
  try { if (fileSystem.readFileSync(target).equals(source)) return false; } catch {}
  fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
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

module.exports = { EVENTS, SCRIPT_NAME, createArrivalHookManager, hookCommand, scriptPath, stableNode, syncScript };
