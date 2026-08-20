'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const packageJson = require('./package.json');

const HOOK_MATCHER = 'startup|resume';
const HOOK_TIMEOUT_SECONDS = 6;
const VERSIONED_HOOK_COMMAND =
  /^npx -y slashvibe-mcp@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)? hook run$/;

class HookSettingsError extends Error {
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = 'HookSettingsError';
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function hookCommand(version = packageJson.version) {
  return `npx -y slashvibe-mcp@${version} hook run`;
}

function settingsPath(env = process.env) {
  const home = env.HOME || os.homedir();
  const claudeDirectory = env.CLAUDE_CONFIG_DIR
    ? path.resolve(String(env.CLAUDE_CONFIG_DIR).replace(/^~(?=$|\/)/, home))
    : path.join(home, '.claude');
  return path.join(claudeDirectory, 'settings.json');
}

function readSettings(target, fileSystem = fs) {
  let raw;
  try {
    raw = fileSystem.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { settings: {}, exists: false, mode: 0o600 };
    throw new HookSettingsError('claude_settings_read_failed', { cause: error });
  }

  try {
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
    const mode = fileSystem.statSync(target).mode & 0o777;
    return { settings, exists: true, mode };
  } catch (error) {
    throw new HookSettingsError('claude_settings_invalid', { cause: error });
  }
}

function validateHookShape(settings) {
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
  ) {
    throw new HookSettingsError('claude_hooks_invalid');
  }
  if (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) {
    throw new HookSettingsError('claude_session_start_hooks_invalid');
  }
}

function ownedHandler(handler, command = hookCommand()) {
  return (
    handler &&
    typeof handler === 'object' &&
    handler.type === 'command' &&
    (handler.command === command || VERSIONED_HOOK_COMMAND.test(handler.command))
  );
}

function removeOwned(settings, command = hookCommand()) {
  validateHookShape(settings);
  if (!Array.isArray(settings.hooks?.SessionStart)) return { settings, removed: 0 };

  let removed = 0;
  const groups = settings.hooks.SessionStart.flatMap((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return [group];
    const handlers = group.hooks.filter((handler) => {
      if (!ownedHandler(handler, command)) return true;
      removed += 1;
      return false;
    });
    return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
  });

  if (removed === 0) return { settings, removed };
  const nextHooks = { ...settings.hooks };
  if (groups.length === 0) delete nextHooks.SessionStart;
  else nextHooks.SessionStart = groups;
  const next = { ...settings };
  if (Object.keys(nextHooks).length === 0) delete next.hooks;
  else next.hooks = nextHooks;
  return { settings: next, removed };
}

function installEntry(settings, command = hookCommand()) {
  const withoutOwned = removeOwned(settings, command);
  const groups = [...(withoutOwned.settings.hooks?.SessionStart || [])];
  groups.push({
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: 'command',
        command,
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  });
  const nextSettings = {
    ...withoutOwned.settings,
    hooks: {
      ...(withoutOwned.settings.hooks || {}),
      SessionStart: groups,
    },
  };
  return {
    settings: nextSettings,
    changed: JSON.stringify(settings) !== JSON.stringify(nextSettings),
  };
}

function atomicWrite(target, settings, mode, fileSystem = fs, randomId = crypto.randomUUID) {
  const directory = path.dirname(target);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.settings.json.vibe-${process.pid}-${randomId()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', mode);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.chmodSync(temporary, mode);
    fileSystem.renameSync(temporary, target);
    try {
      const directoryDescriptor = fileSystem.openSync(directory, 'r');
      try {
        fileSystem.fsyncSync(directoryDescriptor);
      } finally {
        fileSystem.closeSync(directoryDescriptor);
      }
    } catch {}
  } catch (error) {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    try {
      fileSystem.unlinkSync(temporary);
    } catch {}
    throw new HookSettingsError('claude_settings_write_failed', { cause: error });
  }
}

function createHookSettingsManager(options = {}) {
  const fileSystem = options.fs || fs;
  const target = options.settingsPath || settingsPath(options.env || process.env);
  const command = options.command || hookCommand(options.version || packageJson.version);
  const randomId = options.randomUUID || crypto.randomUUID;

  function status() {
    const current = readSettings(target, fileSystem);
    validateHookShape(current.settings);
    const count = (current.settings.hooks?.SessionStart || []).reduce(
      (total, group) =>
        total +
        (Array.isArray(group?.hooks)
          ? group.hooks.filter((handler) => ownedHandler(handler, command)).length
          : 0),
      0
    );
    return { installed: count > 0, count, path: target, command };
  }

  function install() {
    const current = readSettings(target, fileSystem);
    const next = installEntry(current.settings, command);
    if (!next.changed) return { ...status(), changed: false };
    atomicWrite(target, next.settings, current.mode, fileSystem, randomId);
    return { ...status(), changed: true };
  }

  function uninstall() {
    const current = readSettings(target, fileSystem);
    const next = removeOwned(current.settings, command);
    if (next.removed === 0) return { ...status(), changed: false, removed: 0 };
    atomicWrite(target, next.settings, current.mode, fileSystem, randomId);
    return { ...status(), changed: true, removed: next.removed };
  }

  return { command, install, status, uninstall };
}

module.exports = {
  HOOK_MATCHER,
  HOOK_TIMEOUT_SECONDS,
  HookSettingsError,
  createHookSettingsManager,
  hookCommand,
  installEntry,
  removeOwned,
  settingsPath,
};
