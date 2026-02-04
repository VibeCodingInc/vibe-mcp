#!/usr/bin/env node
/**
 * Sync version.json and server.json with package.json version.
 * Run before publishing: npm run version-sync
 */
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

// Sync version.json
const versionPath = path.join(__dirname, '..', 'version.json');
const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
if (versionData.version !== version) {
  versionData.version = version;
  versionData.updated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(versionPath, JSON.stringify(versionData, null, 2) + '\n');
  console.log(`version.json synced to ${version}`);
}

// Sync server.json
const serverPath = path.join(__dirname, '..', 'server.json');
const serverData = JSON.parse(fs.readFileSync(serverPath, 'utf8'));
let serverChanged = false;
if (serverData.version !== version) {
  serverData.version = version;
  serverChanged = true;
}
if (serverData.packages && serverData.packages[0] && serverData.packages[0].version !== version) {
  serverData.packages[0].version = version;
  serverChanged = true;
}
if (serverChanged) {
  fs.writeFileSync(serverPath, JSON.stringify(serverData, null, 2) + '\n');
  console.log(`server.json synced to ${version}`);
}

console.log(`All versions synced to ${version}`);
