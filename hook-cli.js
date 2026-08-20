'use strict';

const { createHookSettingsManager, HookSettingsError } = require('./session-start-hook-settings');

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
  if (action === 'install') {
    const result = manager.install();
    process.stdout.write(
      result.changed
        ? `/vibe read-only SessionStart resurfacing installed. Restart Claude Code, then use /hooks to verify it.\n`
        : `/vibe read-only SessionStart resurfacing was already installed.\n`
    );
    return;
  }
  if (action === 'uninstall') {
    const result = manager.uninstall();
    process.stdout.write(
      result.changed
        ? `/vibe read-only SessionStart resurfacing removed.\n`
        : `/vibe read-only SessionStart resurfacing was not installed.\n`
    );
    return;
  }
  if (action === 'status') {
    printStatus(manager.status());
    return;
  }

  throw new HookSettingsError('hook_command_invalid', {
    message: 'Usage: npx slashvibe-mcp hook <install|status|uninstall>',
  });
}

module.exports = { run };
