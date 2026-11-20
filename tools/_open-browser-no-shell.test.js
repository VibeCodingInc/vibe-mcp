'use strict';
// Opening the sign-in page never goes through a shell: the URL is one argument
// to the opener on every platform, so nothing in it can run as a command. If
// the opener fails, the person is still told where to go.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

process.env.VIBE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-browser-'));
process.env.VIBE_SETUP_NO_AUTORUN = '1';
delete process.env.VIBE_SETUP_STUB_BROWSER;

// setup.js takes execFile from child_process when it loads; stub it first.
const calls = [];
let fail = false;
const origExecFile = childProcess.execFile;
const origExec = childProcess.exec;
childProcess.execFile = (file, args, cb) => { calls.push({ file, args }); cb(fail ? new Error('no opener') : null); };
childProcess.exec = () => { throw new Error('openBrowser must not use a shell'); };
const { openBrowser } = require('../setup');
childProcess.execFile = origExecFile;
childProcess.exec = origExec;

const URL_WITH_SHELL_CHARS = 'https://www.slashvibe.dev/login?a=1&b="x"&c=$(touch pwned)';

function onPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

test('each platform gets its opener with the URL as one untouched argument', () => {
  const want = {
    darwin: { file: 'open', args: [URL_WITH_SHELL_CHARS] },
    linux: { file: 'xdg-open', args: [URL_WITH_SHELL_CHARS] },
    win32: { file: 'rundll32', args: ['url.dll,FileProtocolHandler', URL_WITH_SHELL_CHARS] },
  };
  for (const [platform, expected] of Object.entries(want)) {
    calls.length = 0;
    onPlatform(platform, () => openBrowser(URL_WITH_SHELL_CHARS));
    assert.deepEqual(calls, [expected], platform);
  }
});

test('when the opener fails, the person is told to open the link themselves', () => {
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(String(s));
  fail = true;
  try { onPlatform('linux', () => openBrowser('https://www.slashvibe.dev/login')); } finally { console.log = origLog; fail = false; }
  const out = lines.join('\n');
  assert.match(out, /Could not open browser automatically/);
  assert.match(out, /Please open: https:\/\/www\.slashvibe\.dev\/login/);
});
