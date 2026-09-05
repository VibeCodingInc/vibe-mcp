#!/usr/bin/env node
/**
 * Two-session loop acceptance (lab identities only) — the exchange agreed with Platform.
 *
 *   lab-A: /vibe-style ask → vibe_draft (rev) → vibe_send_draft (approved_sha256)  → msg_1
 *   lab-B: answers from its own side → vibe_draft { reply_to: msg_1 } → send      → msg_2
 *   lab-A restarts (fresh process) → vibe_moves → replies[0].verified === true, message_id === msg_2
 *
 * Runs each side as a plain `npx slashvibe-mcp@<version>` MCP server over stdio with its own
 * VIBE_HOME. Mints come ONLY from the environment (VIBE_LAB_A_MINT, VIBE_LAB_B_MINT) and are
 * never printed. Receipts go under receipts/. No human identity is ever used here: this is the
 * automated leg; a human leg needs that human's explicit approval in their own session.
 *
 * Usage:
 *   VIBE_LAB_A=vibecanary VIBE_LAB_A_MINT=… VIBE_LAB_B=vibecanary2 VIBE_LAB_B_MINT=… \
 *   VIBE_API_URL=https://www.slashvibe.dev node scripts/loop-acceptance.mjs 0.8.28
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.argv[2] || 'latest';
const API = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
const A = { handle: need('VIBE_LAB_A'), mint: need('VIBE_LAB_A_MINT') };
const B = { handle: need('VIBE_LAB_B'), mint: need('VIBE_LAB_B_MINT') };
const OUT = path.resolve(process.env.RECEIPTS_DIR || 'receipts');
fs.mkdirSync(OUT, { recursive: true });
const receipt = { version: VERSION, api: API, started: new Date().toISOString(), steps: [] };
function need(k) { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; }

/** A signed-in home for one lab identity. The mint is written to the private config only. */
function homeFor(side) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-lab-${side.handle}-`));
  fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(home, '.vibe', 'auth.json'), JSON.stringify({ token: side.mint, handle: side.handle, provider: 'mint', authenticated_at: now }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.vibe', 'config.json'), JSON.stringify({ username: side.handle, handle: side.handle, authToken: side.mint, authMethod: 'browser', authenticatedAt: now, createdAt: now }), { mode: 0o600 });
  return home;
}

/** One MCP session over stdio. */
function session(side, home) {
  // VERSION 'local' runs this checkout (for the stub-backed rehearsal); anything else is the published package.
  const cmd = VERSION === 'local' ? ['node', [path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.js')]] : ['npx', ['-y', `slashvibe-mcp@${VERSION}`]];
  const child = spawn(cmd[0], cmd[1], { env: { ...process.env, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_API_URL: API, VIBE_SETUP_NO_AUTORUN: '1', VIBE_LAB_A_MINT: '', VIBE_LAB_B_MINT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let nextId = 1;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line); if (o.id && waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); } } catch {} } });
  child.stderr.on('data', () => {});
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000); });
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const text = (r.result && r.result.content || []).map(c => c.text || '').join('\n'); let data = null; try { data = r.result && r.result.structuredContent ? r.result.structuredContent : null; } catch {} return { text, data, raw: r }; };
  return { side, child, async init() { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loop-acceptance', version: '0' } }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); }, call, close() { try { child.stdin.end(); child.kill(); } catch {} } };
}

const grab = (re, s) => { const m = re.exec(s || ''); return m ? m[1] : null; };
function step(name, obj) { receipt.steps.push({ name, at: new Date().toISOString(), ...obj }); console.log(`· ${name}: ${JSON.stringify(obj).slice(0, 200)}`); }

async function main() {
  const homeA = homeFor(A), homeB = homeFor(B);
  // ── leg 1: A asks B (approval-bound) ──
  let a = session(A, homeA); await a.init();
  const ask = await a.call('vibe_draft', { handle: `@${B.handle}`, message: `re: loop acceptance — quick one: which side should decide the local/cloud handoff? (${new Date().toISOString()})` });
  const askId = grab(/_\(draft ([a-z0-9-]+)/i, ask.text) || grab(/draft ([a-z0-9-]+) ·/i, ask.text); const askRev = grab(/rev ([0-9a-f]{8})/i, ask.text);
  if (!askId || !askRev) throw new Error('A: no draft id/rev in preview');
  const sent1 = await a.call('vibe_send_draft', { id: askId, rev: askRev });
  const msg1 = grab(/receipt: (msg_[A-Za-z0-9_-]+)/, sent1.text) || grab(/\b(msg_[A-Za-z0-9_-]+)/, sent1.text);
  if (!/^Sent to \*\*@/.test(sent1.text) || !msg1) throw new Error(`A: send not confirmed: ${sent1.text.slice(0, 200)}`);
  step('A sent approval-bound ask', { draft: askId, rev: askRev, msg_1: msg1 });
  a.close();

  // ── leg 2: B answers with reply_to = msg_1 ──
  const b = session(B, homeB); await b.init();
  const moves = await b.call('vibe_moves', { context: { project: 'loop acceptance', result: 'the cloud side decides the local/cloud handoff; the local side only reports capacity' } });
  const primaryTo = grab(/→ @([a-z0-9_-]+)/i, moves.text);
  step('B moves', { primary_to: primaryTo, answers: grab(/answers: #(msg_[A-Za-z0-9_-]+)/, moves.text) });
  const ans = await b.call('vibe_draft', { handle: `@${A.handle}`, message: 're: loop acceptance — the cloud side decides; local only reports capacity.', reply_to: msg1 });
  const ansId = grab(/_\(draft ([a-z0-9-]+)/i, ans.text) || grab(/draft ([a-z0-9-]+) ·/i, ans.text); const ansRev = grab(/rev ([0-9a-f]{8})/i, ans.text);
  if (!/\*\*Answers:\*\* #/.test(ans.text)) throw new Error('B: preview did not show the reply target');
  const sent2 = await b.call('vibe_send_draft', { id: ansId, rev: ansRev });
  const msg2 = grab(/receipt: (msg_[A-Za-z0-9_-]+)/, sent2.text) || grab(/\b(msg_[A-Za-z0-9_-]+)/, sent2.text);
  if (!/^Sent to \*\*@/.test(sent2.text) || !msg2) throw new Error(`B: send not confirmed: ${sent2.text.slice(0, 200)}`);
  step('B sent verifiable answer', { draft: ansId, rev: ansRev, msg_2: msg2, reply_to: msg1 });
  b.close();

  // ── leg 3: A restarts and sees the verified reply beside the work ──
  a = session(A, homeA); await a.init();
  const back = await a.call('vibe_moves', { context: { project: 'loop acceptance', doing: 'wiring the handoff' } });
  const verified = /↩ @[a-z0-9_-]+ replied to what you sent/i.test(back.text);
  step('A restarted and read replies', { verified_line: verified, text: back.text.split('\n').slice(0, 3).join(' | ') });
  a.close();

  receipt.result = verified ? 'PASS' : 'FAIL';
  receipt.msg_1 = msg1; receipt.msg_2 = msg2; receipt.finished = new Date().toISOString();
  const file = path.join(OUT, `loop-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
  console.log(`${receipt.result} — receipt ${file}`);
  process.exit(verified ? 0 : 1);
}
main().catch((e) => { receipt.error = String(e && e.message || e); fs.writeFileSync(path.join(OUT, `loop-${Date.now()}-error.json`), JSON.stringify(receipt, null, 2)); console.error('FAIL:', receipt.error); process.exit(1); });
