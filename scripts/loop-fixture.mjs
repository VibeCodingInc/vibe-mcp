// Live loop fixture boundary: only the two named CI agents, never ambient identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIVE_API = 'https://www.slashvibe.dev';
export function assertRunning(stopping) {
  if (stopping) throw new Error('Loop fixture is shutting down; no new work');
}
export function validatePair(a, b, api) {
  if (api !== LIVE_API || a.handle !== 'vibecanary' || b.handle !== 'vibecanary2') {
    throw new Error('Only the dedicated canary pair at the canonical production origin is allowed');
  }
  if (!a.mint || !b.mint) throw new Error('Both dedicated mint credentials are required');
}

export function redactor(secrets) {
  return input => {
    let out = String(input ?? '');
    for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
    return out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
  };
}

export async function mintSession(side, secrets, request = fetch) {
  // A mint is a password, NOT a session JWT. Never write it into a client's home.
  const result = await request(`${LIVE_API}/api/auth/buddy-token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'x-agent-mint': side.mint },
    body: JSON.stringify({ handle: side.handle }),
  });
  if (result.status !== 200) throw new Error(`Lab mint refused (HTTP ${result.status})`);
  let data;
  try { data = await result.json(); } catch { throw new Error('Lab mint returned invalid JSON'); }
  const token = data?.token;
  if (typeof token !== 'string') throw new Error('Lab mint returned no session');
  secrets.add(token);
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { throw new Error('Lab mint returned invalid session claims'); }
  if (data.handle !== side.handle || claims.sub !== side.handle || claims.handle !== side.handle || claims.mint !== 'agent' || !claims.principal_id) {
    throw new Error('Lab mint identity or durable principal mismatch');
  }
  const checked = await request(`${LIVE_API}/api/auth/verify`, {
    redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}` },
  });
  let verified;
  try { verified = await checked.json(); } catch { throw new Error('Lab verification returned invalid JSON'); }
  if (checked.status !== 200 || verified?.valid !== true || verified.handle !== side.handle) throw new Error('Lab session verification failed');
  return token;
}

export function signedInHome(handle, token, homes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-lab-loop-'));
  homes.add(dir); // Track immediately so partial writes are cleaned too.
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, '.vibe'), { mode: 0o700 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.vibe', 'auth.json'), JSON.stringify({ token, handle, provider: 'mint', authenticated_at: now }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.vibe', 'config.json'), JSON.stringify({ username: handle, handle, authToken: token, authMethod: 'browser', authenticatedAt: now, createdAt: now }), { mode: 0o600 });
  return dir;
}

export function childEnvironment(dir, source = process.env) {
  // No inherited GH/Vercel tokens, mint passwords, NODE_OPTIONS, proxies, or ambient auth.
  const allowed = ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(allowed.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
  return { ...env, HOME: dir, VIBE_HOME: path.join(dir, '.vibe'), VIBE_API_URL: LIVE_API, VIBE_SETUP_NO_AUTORUN: '1' };
}

export function childCloser(child, onClosed) {
  let pending;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        child.once('close', () => { clearTimeout(timeout); resolve(); });
        child.stdin.end();
        child.kill('SIGTERM');
      });
      onClosed();
    })();
    return pending;
  };
}

export function cleanHomes(homes) {
  for (const dir of homes) {
    // Only exact directories created by signedInHome, never a glob or workspace root.
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('vibe-lab-loop-')) throw new Error('Refusing unsafe fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
    homes.delete(dir);
  }
}
