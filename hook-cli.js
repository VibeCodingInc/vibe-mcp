'use strict';

const { createHookSettingsManager, HookSettingsError } = require('./session-start-hook-settings');
const { createArrivalHookManager } = require('./arrival-hook-settings');

// Two hooks, one switch. SessionStart shows what was WAITING when a session
// opens; the arrival hook shows what ARRIVES while you work (arrival.js).
function arrivalLine(result) {
  return result.installed
    ? `/vibe arrival hook is installed — a message reaches you at your next prompt or tool call.\n${result.script}\n`
    : `/vibe arrival hook is not installed.\n`;
}

function printStatus(result) {
  if (result.installed) {
    process.stdout.write(
      `/vibe read-only SessionStart resurfacing is installed.\n${result.path}\n`
    );
  } else {
    process.stdout.write(
      `/vibe read-only SessionStart resurfacing is not installed.\n${result.path}\n`
    );
  }
}

async function run(args = []) {
  const action = args[0];
  if (action === 'run') {
    const hook = require('./session-start-hook.cjs');
    await hook.main();
    return;
  }

  const manager = createHookSettingsManager();
  const arrivals = createArrivalHookManager();
  if (action === 'install') {
    const result = manager.install();
    const arrived = arrivals.install();
    process.stdout.write(
      arrived.changed
        ? `/vibe arrival hook installed — while you work, a message reaches you at your next prompt or tool call. It reads a local file only; nothing is marked read.\n`
        : `/vibe arrival hook was already installed.\n`
    );
    process.stdout.write(
      result.changed
        ? `/vibe read-only SessionStart resurfacing installed. Restart Claude Code, then use /hooks to verify it.\n`
        : `/vibe read-only SessionStart resurfacing was already installed.\n`
    );
    return;
  }
  if (action === 'uninstall') {
    const result = manager.uninstall();
    const arrived = arrivals.uninstall();
    process.stdout.write(arrived.changed ? `/vibe arrival hook removed.\n` : `/vibe arrival hook was not installed.\n`);
    process.stdout.write(
      result.changed
        ? `/vibe read-only SessionStart resurfacing removed.\n`
        : `/vibe read-only SessionStart resurfacing was not installed.\n`
    );
    return;
  }
  if (action === 'status') {
    printStatus(manager.status());
    process.stdout.write(arrivalLine(arrivals.status()));
    return;
  }

  throw new HookSettingsError('hook_command_invalid', {
    message: 'Usage: npx slashvibe-mcp hook <install|status|uninstall>',
  });
}

module.exports = { run };
