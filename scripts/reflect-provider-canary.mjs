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
// The canary certifies INTEGRATION: only a real reflection is a PASS
// (review round 2: no_data must not pass vacuously — it exits 3, honest but
// uncertified, so CI on a data-less machine cannot green-wash the contract).
if (d.outcome === 'no_data') {
  console.log(`NO_DATA: real provider ran but this machine has no /insights data — integration NOT certified here`);
  process.exit(3);
}
const problems = [];
if (d.outcome !== 'reflection') problems.push(`outcome ${d.outcome}, wanted reflection`);
if (typeof d.archetype !== 'string' || !d.archetype.trim()) problems.push('no archetype string');
if (!d.provenance || !d.provenance.version) problems.push('no provider version provenance');
if (!/private reflection/.test(res.display)) problems.push('display missing private framing');
const verdict = problems.length ? 'FAIL' : 'PASS';
console.log(`${verdict}: real provider ${cli.split('/').slice(-2).join('/')} · archetype=[${d.archetype ? 'present, not printed' : 'absent'}] · version=${d.provenance?.version || 'n/a'}${problems.length ? ' · ' + problems.join(' | ') : ''}`);
process.exit(problems.length ? 1 : 0);
