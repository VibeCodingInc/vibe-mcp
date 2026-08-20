#!/usr/bin/env node

/**
 * /vibe CLI entry point
 *
 * Routes commands:
 *   npx slashvibe-mcp        → auto-setup (if TTY + not initialized) or MCP server
 *   npx slashvibe-mcp setup  → interactive setup wizard
 *
 * This file exists because npm rejects "index.js" as a bin script name
 * in some versions (warning: "bin[slashvibe-mcp] script name index.js was invalid").
 * Using a dedicated cli.js avoids the issue entirely.
 */

const args = process.argv.slice(2);

if (args[0] === 'hook') {
  require('./hook-cli')
    .run(args.slice(1))
    .catch((error) => {
      if (args[1] === 'run') {
        process.stdout.write(JSON.stringify({ suppressOutput: true }));
      } else {
        process.stderr.write(`${error?.message || error}\n`);
        process.exitCode = 1;
      }
    });
} else if (args.includes('setup')) {
  require('./setup.js');
} else if (process.stdin.isTTY) {
  // Running from terminal (not as MCP server)
  const config = require('./config');
  const authStore = require('./auth-store');

  // A TOKEN EXISTING IS NOT BEING SIGNED IN.
  //
  // This used to pass on `config.getAuthToken()` being truthy, which is true of a
  // credential that expired months ago. On a Mac Studio holding a token 23 days dead it
  // printed "/vibe is configured" and suggested restarting the coding agent — advice that
  // cannot help, given to someone whose only real problem was that they were signed out.
  // The recovery path told them there was nothing to recover.
  const cred = authStore.inspectToken(config.getAuthToken());

  if (!config.isInitialized() && !cred.ok) {
    // Never signed in — set up.
    require('./setup.js');
  } else if (!cred.ok && cred.reason !== 'none') {
    // Signed in once, not any more. Say which, and fix it rather than describing it.
    const when = cred.expiresAt
      ? ` (it expired ${Math.max(1, Math.round((Date.now() - cred.expiresAt) / 86400000))} days ago)`
      : '';
    console.log(cred.handle
      ? `Your /vibe sign-in for @${cred.handle} is no longer valid${when}.`
      : `Your /vibe sign-in is no longer valid${when}.`);
    console.log('Signing you back in...');
    console.log('');
    require('./setup.js');
  } else {
    // Genuinely signed in — say WHO, because a status line that cannot name you is the
    // one that hid this in the first place.
    console.log(cred.handle
      ? `/vibe is configured — signed in as @${cred.handle}.`
      : '/vibe is configured.');
    console.log('Restart your coding agent (Claude Code / Codex / Cursor) to connect.');
    console.log('');
    console.log('Commands:');
    console.log('  npx slashvibe-mcp setup   — re-run setup wizard');
    console.log('');
    console.log('In Claude Code, just say "who\'s vibing?" to get started.');
    process.exit(0);
  }
} else {
  // Running as MCP server (stdin is a pipe from Claude Code)
  require('./index.js');
}
