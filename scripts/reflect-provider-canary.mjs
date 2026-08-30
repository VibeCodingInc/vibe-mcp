#!/usr/bin/env node
/**
 * Real-provider reflect canary (vibe-mcp#24 acceptance): run vibe_reflect
 * against the ACTUAL VibeStats executable named by VIBE_STATS_CLI and prove
 * the integration — shape, provenance, and privacy (this canary prints NO
 * reflection content, only verdicts).
 */
import { existsSync } from 'node:fs';

const cli = process.env.VIBE_STATS_CLI;
if (!cli || !existsSync(cli)) {
  console.log('SKIP: set VIBE_STATS_CLI to the real vibestats executable');
  process.exit(2);
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const reflect = require('../tools/reflect.js');

const res = await reflect.handler({});
const d = res.data || {};
const problems = [];
if (d.capability) problems.push(`capability gate blocked: ${JSON.stringify(d.capability)}`);
if (d.provider_error) problems.push('provider failed to answer');
if (!d.no_data && !d.provider_error && !d.capability) {
  if (typeof d.archetype !== 'string' || !d.archetype.trim()) problems.push('no archetype string');
  if (!d.provenance || !d.provenance.version) problems.push('no provider version provenance');
  if (!/private reflection/.test(res.display)) problems.push('display missing private framing');
}
const outcome = d.no_data ? 'NO_DATA (honest)' : problems.length ? 'FAIL' : 'PASS';
console.log(`${outcome}: real provider ${cli.split('/').slice(-2).join('/')} · archetype=${d.archetype ? '[present, not printed]' : 'n/a'} · version=${d.provenance?.version || 'n/a'}${problems.length ? ' · ' + problems.join(' | ') : ''}`);
process.exit(problems.length ? 1 : 0);
