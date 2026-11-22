#!/usr/bin/env node
'use strict';
// TESTS ONLY (not in the npm package): the real /vibe server with the
// stateless (2026-07-28) path turned on, which index.js SERVE_STATELESS keeps
// off for everyone else. Its tests run through this:
//
//   node test/fixtures/stateless-server.cjs            serve 2026-07-28, no stateless box
//   node test/fixtures/stateless-server.cjs --box-shown   ...and count a stateless box as shown
const path = require('path');
require(path.join(__dirname, '..', '..', 'index.js')).start({
  serveStateless: true,
  statelessBoxShown: process.argv.includes('--box-shown'),
});
