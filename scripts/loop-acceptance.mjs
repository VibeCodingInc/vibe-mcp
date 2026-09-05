#!/usr/bin/env node
/**
 * Two-session loop acceptance (lab identities only) — the exchange agreed with Platform.
 *
 *   lab-A: /vibe-style ask → vibe_draft (rev) → vibe_send_draft (approved_sha256)  → msg_1
 *   lab-B: answers from its own side → vibe_draft { reply_to: msg_1 } → send      → msg_2
 *   lab-A restarts (fresh process) → vibe_moves → replies[0].verified === true, message_id === msg_2
 *
 * Runs each side from this pinned checkout as an MCP server over stdio with its own
 * VIBE_HOME. Mints come ONLY from the environment (VIBE_LAB_A_MINT, VIBE_LAB_B_MINT) and are
 * never printed. Receipts go under receipts/. No human identity is ever used here: this is the
 * automated leg; a human leg needs that human's explicit approval in their own session.
 *
 * Usage:
 *   VIBE_LAB_A=vibecanary VIBE_LAB_A_MINT=… VIBE_LAB_B=vibecanary2 VIBE_LAB_B_MINT=… \
 *   VIBE_API_URL=https://www.slashvibe.dev node scripts/loop-acceptance.mjs local
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRunning, validatePair, redactor, mintSession, signedInHome, childEnvironment, childCloser, cleanHomes } from './loop-fixture.mjs';

const VERSION = process.argv[2] || 'local';
const API = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
const A = { handle: need('VIBE_LAB_A'), mint: need('VIBE_LAB_A_MINT') };
const B = { handle: need('VIBE_LAB_B'), mint: need('VIBE_LAB_B_MINT') };
const OUT = path.resolve(process.env.RECEIPTS_DIR || 'receipts');
validatePair(A, B, API);
if (VERSION !== 'local') throw new Error('Live credentials require a pinned checkout (version=local); no npx subprocess tree');
const secrets = new Set([A.mint, B.mint]);
const redact = redactor(secrets);
const homes = new Set();
const sessions = new Set();
process.on('uncaughtException', () => { console.error('FAIL: unexpected fixture error (details withheld)'); shutdown(1); });
process.on('unhandledRejection', () => { console.error('FAIL: unexpected fixture rejection (details withheld)'); shutdown(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shutdown(1); });
fs.mkdirSync(OUT, { recursive: true });
const receipt = { version: VERSION, api: API, started: new Date().toISOString(), steps: [] };
function need(k) { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; }

/** One MCP session over stdio. */
function session(side, home) {
  assertRunning(shuttingDown);
  const child = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')], { env: childEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let nextId = 1;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line); if (o.id && waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); } } catch {} } });
  child.stderr.on('data', () => {});
  child.on('error', () => {}); // RPC timeout is the bounded failure; never echo spawn env.
  const rpc = (method, params) => new Promise((resolve, reject) => { assertRunning(shuttingDown); const id = nextId++; const timer = setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000); waiters.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const text = (r.result && r.result.content || []).map(c => c.text || '').join('\n'); let data = null; try { data = r.result && r.result.structuredContent ? r.result.structuredContent : null; } catch {} return { text, data, raw: r }; };
  const instance = { side, child, async init() { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loop-acceptance', version: '0' } }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); }, call, close: childCloser(child, () => sessions.delete(instance)) };
  sessions.add(instance);
  return instance;
}

const grab = (re, s) => { const m = re.exec(s || ''); return m ? m[1] : null; };
function step(name, obj) { receipt.steps.push({ name, at: new Date().toISOString(), ...obj }); console.log(`· ${name}: ${redact(JSON.stringify(obj)).slice(0, 200)}`); }

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...sessions].map(s => s.close()));
  try { cleanHomes(homes); } catch { console.error('Fixture home cleanup failed (path withheld)'); code = 1; }
  process.exit(code);
}

async function main() {
  // Authenticate and prove BOTH agent identities before any messaging side effect.
  const tokenA = await mintSession(A, secrets), tokenB = await mintSession(B, secrets);
  const homeA = signedInHome(A.handle, tokenA, homes), homeB = signedInHome(B.handle, tokenB, homes);
  const runTag = Date.now().toString(36);
  const answerText = `re: loop ${runTag} — cloud decides; local reports capacity.`;
  // ── leg 1: A asks B (approval-bound) ──
  let a = session(A, homeA); await a.init();
  const ask = await a.call('vibe_draft', { handle: `@${B.handle}`, message: `re: loop ${runTag} — quick one: which side should decide the local/cloud handoff?` });
  const askId = grab(/_\(draft ([a-z0-9-]+)/i, ask.text) || grab(/draft ([a-z0-9-]+) ·/i, ask.text); const askRev = grab(/rev ([0-9a-f]{8})/i, ask.text);
  if (!askId || !askRev) throw new Error('A: no draft id/rev in preview');
  const sent1 = await a.call('vibe_send_draft', { id: askId, rev: askRev });
  const msg1 = grab(/receipt: (msg_[A-Za-z0-9_-]+)/, sent1.text) || grab(/\b(msg_[A-Za-z0-9_-]+)/, sent1.text);
  if (!/^Sent to \*\*@/.test(sent1.text) || !msg1) throw new Error('A: send not confirmed');
  step('A sent approval-bound ask', { draft: askId, rev: askRev, msg_1: msg1 });
  await a.close();

  // ── leg 2: B answers with reply_to = msg_1 ──
  const b = session(B, homeB); await b.init();
  const moves = await b.call('vibe_moves', { context: { project: 'loop acceptance', result: 'the cloud side decides the local/cloud handoff; the local side only reports capacity' } });
  const primaryTo = grab(/→ @([a-z0-9_-]+)/i, moves.text);
  step('B moves', { primary_to: primaryTo, answers: grab(/answers: #(msg_[A-Za-z0-9_-]+)/, moves.text) });
  const ans = await b.call('vibe_draft', { handle: `@${A.handle}`, message: answerText, reply_to: msg1 });
  const ansId = grab(/_\(draft ([a-z0-9-]+)/i, ans.text) || grab(/draft ([a-z0-9-]+) ·/i, ans.text); const ansRev = grab(/rev ([0-9a-f]{8})/i, ans.text);
  if (!/\*\*Answers:\*\* #/.test(ans.text)) throw new Error('B: preview did not show the reply target');
  const sent2 = await b.call('vibe_send_draft', { id: ansId, rev: ansRev });
  const msg2 = grab(/receipt: (msg_[A-Za-z0-9_-]+)/, sent2.text) || grab(/\b(msg_[A-Za-z0-9_-]+)/, sent2.text);
  if (!/^Sent to \*\*@/.test(sent2.text) || !msg2) throw new Error('B: send not confirmed');
  step('B sent verifiable answer', { draft: ansId, rev: ansRev, msg_2: msg2, reply_to: msg1 });
  await b.close();

  // ── leg 3: A restarts and sees the verified reply beside the work ──
  a = session(A, homeA); await a.init();
  const back = await a.call('vibe_moves', { context: { project: 'loop acceptance', doing: 'wiring the handoff' } });
  // Bind to THIS answer, not an arbitrary historic "replied" line. Platform then
  // independently checks the exact served msg_2 / reply_to / direction / freshness.
  const verified = back.text.split('\n').some(line => line.includes(`↩ @${B.handle} replied to what you sent`) && line.includes(answerText));
  step('A restarted and read replies', { verified_line: verified, answer_bound_to_this_run: verified });
  await a.close();

  receipt.result = verified ? 'PASS' : 'FAIL';
  receipt.restart = { ok: verified, saw_reply: verified };
  receipt.msg_1 = msg1; receipt.msg_2 = msg2; receipt.finished = new Date().toISOString();
  const file = path.join(OUT, `loop-${Date.now()}.json`);
  fs.writeFileSync(file, redact(JSON.stringify(receipt, null, 2)), { mode: 0o600 });
  console.log(`${receipt.result} — receipt ${file}`);
  await shutdown(verified ? 0 : 1);
}
main().catch(async (e) => { receipt.error = redact(String(e && e.message || e)); fs.writeFileSync(path.join(OUT, `loop-${Date.now()}-error.json`), redact(JSON.stringify(receipt, null, 2)), { mode: 0o600 }); console.error('FAIL:', receipt.error); await shutdown(1); });
