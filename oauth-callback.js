'use strict';

const crypto = require('crypto');
const http = require('http');

const CALLBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_PORT = 9876;
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_GRACE_MS = 300000;
const LOGIN_URL = 'https://www.slashvibe.dev/login';
const ACTOR_BODY_LIMIT = 8192;
const ACTOR_REFRESH_PATTERN = /^vrt_[A-Za-z0-9_-]{43}$/;
const ACTOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUCCESS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>signed in to /vibe</title>
  <link rel="stylesheet" href="https://www.slashvibe.dev/vibe-tokens.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg, #0A0A0A);
      color: var(--dim, #9CA3AF);
      font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: var(--t-14, 14px);
      line-height: 1.6;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: var(--s-6, 24px);
    }
    .card {
      border: 1px solid var(--line, #1F2937);
      border-radius: var(--r-lg, 10px);
      background: var(--panel, #111316);
      padding: var(--s-8, 32px);
      max-width: 420px; width: 100%;
    }
    .logo { color: var(--ink, #E0E0E0); font-size: var(--t-16, 16px); margin-bottom: var(--s-6, 24px); }
    .logo span { color: var(--blue, #6B8FFF); }
    .line { color: var(--ink, #E0E0E0); font-size: var(--t-20, 20px); margin-bottom: var(--s-2, 8px); }
    .dot { color: var(--green, #22c55e); }
    .meta { font-size: var(--t-13, 13px); }
    .next {
      margin-top: var(--s-6, 24px); padding-top: var(--s-4, 16px);
      border-top: 1px solid var(--line, #1F2937); font-size: var(--t-13, 13px);
    }
    code {
      color: var(--ink, #E0E0E0);
      background: var(--bg, #0A0A0A);
      border: 1px solid var(--line, #1F2937);
      border-radius: var(--r-sm, 6px);
      padding: 1px 6px;
    }
    .close { color: var(--faint, #6B7280); font-size: var(--t-11, 11px); margin-top: var(--s-6, 24px); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">/<span>vibe</span></div>
    <p class="line"><span class="dot">&#x1F7E2;</span> you're in</p>
    <p class="meta">your session is signed in and you're on the board.</p>
    <div class="next">
      back in your terminal, say <code>vibe who</code> to see who's around,
      or <code>vibe inbox</code> if someone already wrote to you.
    </div>
    <p class="close">you can close this window.</p>
  </div>
</body>
</html>`;

const LATE_CALLBACK_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>sign-in timed out · /vibe</title>
<link rel="stylesheet" href="https://www.slashvibe.dev/vibe-tokens.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg,#0A0A0A);color:var(--dim,#9CA3AF);font-family:var(--mono,ui-monospace,Menlo,monospace);
       font-size:var(--t-14,14px);line-height:1.6;min-height:100vh;display:flex;align-items:center;
       justify-content:center;padding:24px}
  .card{border:1px solid var(--line,#1F2937);border-radius:var(--r-lg,10px);background:var(--panel,#111316);
        padding:32px;max-width:420px;width:100%}
  .logo{color:var(--ink,#E0E0E0);font-size:var(--t-16,16px);margin-bottom:24px}
  .logo span{color:var(--blue,#6B8FFF)}
  h1{color:var(--ink,#E0E0E0);font-size:var(--t-20,20px);font-weight:600;margin-bottom:8px}
  code{color:var(--ink,#E0E0E0);background:var(--bg,#0A0A0A);border:1px solid var(--line,#1F2937);
       border-radius:var(--r-sm,6px);padding:1px 6px}
  .next{margin-top:24px;padding-top:16px;border-top:1px solid var(--line,#1F2937);font-size:var(--t-13,13px)}
</style></head>
<body><div class="card">
  <div class="logo">/<span>vibe</span></div>
  <h1>sign-in took too long</h1>
  <p>your terminal stopped waiting, so this sign-in didn't finish. nothing is broken and
  nothing was saved.</p>
  <div class="next">back in your terminal, say <code>vibe init</code> and it will open a fresh
  sign-in. this window can be closed.</div>
</div></body></html>`;

const BAD_CALLBACK_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>sign-in could not finish · /vibe</title></head>
<body><p>this sign-in callback could not be accepted. return to your terminal and try again.</p></body></html>`;

function actorCapturePage(state) {
  const script = `<script>
  (() => {
    const body = window.location.hash.slice(1) || 'actor_status=unavailable';
    window.history.replaceState(null, '', window.location.pathname);
    fetch('/actor-callback?state=' + encodeURIComponent(${JSON.stringify(state)}), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      cache: 'no-store',
      credentials: 'omit',
      body
    }).catch(() => {});
  })();
</script>`;
  return SUCCESS_PAGE.replace('</body>', `${script}\n</body>`);
}

function readBody(request, limit = ACTOR_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('ACTOR_CALLBACK_TOO_LARGE'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function actorSessionFromBody(body) {
  const fields = new URLSearchParams(body);
  if (fields.get('actor_status') === 'unavailable') {
    const credentialFields = [
      'actor_access_token',
      'actor_refresh_token',
      'principal_id',
      'runtime_id',
      'handle_version',
    ];
    return credentialFields.some((field) => fields.has(field)) ? undefined : null;
  }

  const accessToken = fields.get('actor_access_token');
  const refreshToken = fields.get('actor_refresh_token');
  const principalId = fields.get('principal_id');
  const runtimeId = fields.get('runtime_id');
  const handleVersion = fields.get('handle_version');
  if (
    typeof accessToken !== 'string' ||
    accessToken.length < 16 ||
    accessToken.length > 4096 ||
    !ACTOR_REFRESH_PATTERN.test(refreshToken || '') ||
    !ACTOR_UUID_PATTERN.test(principalId || '') ||
    !ACTOR_UUID_PATTERN.test(runtimeId || '') ||
    !ACTOR_UUID_PATTERN.test(handleVersion || '')
  ) {
    return undefined;
  }
  return { accessToken, refreshToken, principalId, runtimeId, handleVersion };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, CALLBACK_HOST);
  });
}

/**
 * Bind the loopback listener, THEN hand back the URL to open.
 * Binding first is load-bearing: opening the browser before the socket exists is
 * what lets a local squatter or a concurrent init receive the credential.
 */
async function beginOAuth({
  requestedHandle,
  actorAware = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
} = {}) {
  const state = crypto.randomBytes(32).toString('hex');
  let phase = 'waiting';
  let timeoutTimer = null;
  let graceTimer = null;
  let resolveCallback;
  let rejectCallback;
  let closePromise;
  let legacyResult = null;

  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A caller can cancel without ever waiting. Keep that from becoming an
  // unhandled rejection while preserving the original promise for waiters.
  callbackPromise.catch(() => {});

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (!res.writableEnded) res.end(BAD_CALLBACK_PAGE);
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${CALLBACK_HOST}`);

    if (url.pathname !== '/callback' && url.pathname !== '/actor-callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BAD_CALLBACK_PAGE);
      return;
    }

    if (phase === 'timedOut') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LATE_CALLBACK_PAGE);
      return;
    }

    if (url.pathname === '/actor-callback') {
      if (!actorAware || req.method !== 'POST' || phase !== 'waitingActor' || !legacyResult) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BAD_CALLBACK_PAGE);
        return;
      }
      let actorSession;
      try {
        actorSession = actorSessionFromBody(await readBody(req));
      } catch {
        actorSession = undefined;
      }
      if (actorSession === undefined) {
        phase = 'completed';
        clearTimeout(timeoutTimer);
        clearTimeout(graceTimer);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BAD_CALLBACK_PAGE, () => closeServer().catch(() => {}));
        rejectCallback(new Error('ACTOR_CALLBACK_INVALID'));
        return;
      }

      phase = 'completed';
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      res.writeHead(204, {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      });
      res.end('', () => closeServer().catch(() => {}));
      resolveCallback({ ...legacyResult, actor: actorSession });
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    const token = url.searchParams.get('token');
    const callbackHandle = url.searchParams.get('handle');
    if (phase !== 'waiting' || !token || !callbackHandle) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BAD_CALLBACK_PAGE);
      return;
    }

    // WHO AUTHENTICATED WINS — not who we asked for. A requested handle is a
    // preference for a brand-new account, never a claim about the credential.
    if (requestedHandle && requestedHandle !== callbackHandle) {
      console.error(
        `[vibe] Signed in as @${callbackHandle} (you asked for @${requestedHandle}) — using the account that authenticated.`
      );
    }

    legacyResult = { token, handle: callbackHandle };
    if (actorAware) {
      phase = 'waitingActor';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      });
      res.end(actorCapturePage(state));
      return;
    }

    phase = 'completed';
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SUCCESS_PAGE, () => { closeServer().catch(() => {}); });
    resolveCallback(legacyResult);
  }

  function closeServer() {
    if (closePromise) return closePromise;
    if (!server.listening) {
      closePromise = Promise.resolve();
      return closePromise;
    }
    closePromise = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    return closePromise;
  }

  try {
    await listen(server, DEFAULT_CALLBACK_PORT);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      phase = 'cancelled';
      rejectCallback(error);
      throw error;
    }

    try {
      await listen(server, 0);
    } catch (fallbackError) {
      phase = 'cancelled';
      const finalError = fallbackError.code === 'EADDRINUSE'
        ? new Error('AUTH_IN_PROGRESS')
        : fallbackError;
      rejectCallback(finalError);
      throw finalError;
    }
  }

  const address = server.address();
  const port = address.port;
  const callbackUrl = new URL(`http://${CALLBACK_HOST}:${port}/callback`);
  callbackUrl.searchParams.set('state', state);
  const loginUrl = new URL(LOGIN_URL);
  loginUrl.searchParams.set('redirect', callbackUrl.toString());
  loginUrl.searchParams.set('state', state);
  if (requestedHandle) loginUrl.searchParams.set('handle', requestedHandle);
  if (actorAware) loginUrl.searchParams.set('actor_aware', 'true');

  timeoutTimer = setTimeout(() => {
    if (phase !== 'waiting' && phase !== 'waitingActor') return;
    phase = 'timedOut';
    rejectCallback(new Error('AUTH_TIMEOUT'));
    graceTimer = setTimeout(() => {
      if (phase === 'timedOut') {
        phase = 'closed';
        closeServer().catch(() => {});
      }
    }, graceMs);
  }, timeoutMs);

  async function cancel() {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    if (phase === 'waiting' || phase === 'waitingActor') {
      phase = 'cancelled';
      rejectCallback(new Error('AUTH_CANCELLED'));
    } else if (phase !== 'closed') {
      phase = 'cancelled';
    }

    await closeServer();
  }

  return {
    loginUrl: loginUrl.toString(),
    port,
    state,
    waitForCallback: () => callbackPromise,
    cancel,
  };
}

module.exports = { beginOAuth };
