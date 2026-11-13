'use strict';
// llms.txt is what another agent reads to learn what /vibe is. It lives HERE,
// beside the code it describes, and is served by the site from each release's
// tag. A copy kept in another repository said 0.9.9 and "agents cannot join"
// two releases after both stopped being true: nobody is wrong on purpose, the
// page was just far from the truth. These checks read the truth from the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const llms = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');

const registered = [...index.slice(index.indexOf('const tools = {'), index.indexOf('};', index.indexOf('const tools = {'))).matchAll(/^\s+(vibe_[a-z_]+):/gm)].map((m) => m[1]);
const commands = JSON.parse(cli.match(/const COMMANDS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));

test('the tool list is exactly the tools the server registers', () => {
  assert.ok(registered.length >= 10, 'could not read the tool registry from index.js');
  const from = llms.indexOf('## Tools'); const to = llms.indexOf('## Things the person types');
  const listed = [...llms.slice(from, to).matchAll(/^- `(vibe_\w+)`/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...registered].sort());
});

test('no tool or terminal command is named that does not exist', () => {
  const named = new Set([...llms.matchAll(/\bvibe_[a-z_]+\b/g)].map((m) => m[0]));
  assert.deepEqual([...named].filter((t) => !registered.includes(t)), []);
  const taught = new Set([...llms.matchAll(/npx slashvibe-mcp(?:@\S+)? ([a-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...taught].filter((c) => !commands.includes(c)), []);
});

test('it names no release number of its own, so it cannot be a release behind', () => {
  assert.doesNotMatch(llms, /`slashvibe-mcp` \d+\.\d+\.\d+/);
  assert.match(llms, /api\/version/);
});

test('one first phrase, the install that works for an agent, one host', () => {
  assert.match(llms, /```text\nwhat's waiting on \/vibe\n```/);
  assert.doesNotMatch(llms, /show me who/i);
  assert.match(llms, /```sh\nnpx slashvibe-mcp setup\n```/);
  assert.match(llms, /Do not run the bare `npx slashvibe-mcp` to install/);
  assert.match(llms, /the complete install command is `npx slashvibe-mcp setup`/);
  assert.doesNotMatch(llms, /\b(Codex|Cursor)\b/);
});

test('it tells an agent the truth about joining: as an agent, never as a person', () => {
  assert.match(llms, /Do not sign in through GitHub as if you were a person/);
  for (const name of ['VIBE_AGENT_HANDLE', 'VIBE_AGENT_MINT_FILE', 'VIBE_HOME']) {
    assert.match(llms, new RegExp(name));
    assert.match(fs.readFileSync(path.join(ROOT, 'agent-auth.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'vibe-home.js'), 'utf8'), new RegExp(name), `${name} is taught but the code does not read it`);
  }
  assert.doesNotMatch(llms, /You cannot, yet/);
});

test('what it says the setup flag does is what the code does', () => {
  assert.match(llms, /setup --from @them/);
  assert.match(fs.readFileSync(path.join(ROOT, 'invite.js'), 'utf8'), /--from/);
});
