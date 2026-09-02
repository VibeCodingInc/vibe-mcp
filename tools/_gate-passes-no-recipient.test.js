'use strict';
// Newcomer walk, 2026-09-01: "message @brightseth — …" before sign-in produced a
// login link carrying handle=brightseth, and config.handle was saved as the
// RECIPIENT. Cause: the unauthenticated gate forwarded the gated tool's arguments
// into vibe_init, whose own `handle` argument means "override YOUR handle".
// The gate must start sign-in with no arguments: GitHub says who you are.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the sign-in gate starts init with NO arguments — a recipient never becomes a requested handle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const gate = src.slice(src.indexOf("if (!isAuthed() && !NO_AUTH_REQUIRED.has(params.name))"));
  const call = gate.match(/initTool\.handler\(([^)]*)\)/);
  assert.ok(call, 'the gate calls vibe_init');
  assert.equal(call[1].trim(), '{}', `gate forwards ${call[1]} into vibe_init; must be {}`);
});
