/**
 * vibe init — Set your identity
 *
 * Smooth browser-based OAuth flow:
 * 1. Start local callback server on localhost:9876
 * 2. Open browser to login page
 * 3. User authenticates with GitHub/X
 * 4. Browser redirects back to localhost with token
 * 5. Tool WAITS for callback and returns success
 */

const http = require('http');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');
const discord = require('../discord');

const CALLBACK_PORT = 9876;
const API_BASE = config.getApiUrl();

/**
 * Fetch online count from presence API
 */
async function getOnlineCount() {
  try {
    const response = await fetch(`${API_BASE}/api/presence`);
    if (!response.ok) return 0;
    const data = await response.json();
    return (data.active?.length || 0) + (data.away?.length || 0);
  } catch (e) {
    return 0;
  }
}

/**
 * Generate welcome banner for new users (pre-auth, no handle yet)
 */
function generatePreAuthBanner(onlineCount) {
  const onlineText = onlineCount > 0 ? `🟢 ${onlineCount} online now` : '🟢 join the crew';
  return `
  █░█ █ █▄▄ █▀▀     🚀 ship together
  ▀▄▀ █ █▄█ ██▄     ${onlineText}
  ──────────────────────────────────────────────────
`;
}

/**
 * Generate welcome banner for authenticated users (with handle + unread)
 */
function generateAuthBanner(handle, unreadCount, onlineCount) {
  // Format: logo | handle + unread | tagline + online
  // Keep alignment consistent with original banner
  const handleCol = `@${handle}`.padEnd(16);
  const unreadCol = unreadCount > 0 ? `📬 ${unreadCount} unread`.padEnd(14) : `📬 0 messages`.padEnd(14);

  return `  █░█ █ █▄▄ █▀▀   ${handleCol}  🚀 ship together
  ▀▄▀ █ █▄█ ██▄   ${unreadCol}  🟢 ${onlineCount} online
  ──────────────────────────────────────────────────`;
}

/**
 * Detect current git repository name
 */
function detectRepoName() {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel 2>/dev/null', {
      encoding: 'utf8',
      timeout: 1000
    }).trim();
    // Split on forward or back slash to get repo name
    const parts = toplevel.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  } catch (e) {
    return null;
  }
}

/**
 * Detect tech stack from package.json or file extensions
 */
function detectTechStack() {
  const techStack = new Set();

  try {
    // Find git root first, fallback to cwd
    let cwd;
    try {
      cwd = execSync('git rev-parse --show-toplevel 2>/dev/null', {
        encoding: 'utf8',
        timeout: 1000
      }).trim();
    } catch (e) {
      cwd = process.cwd();
    }

    // Try reading package.json
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Map common packages to tech names
      const techMap = {
        react: 'React',
        next: 'Next.js',
        vue: 'Vue',
        svelte: 'Svelte',
        express: 'Express',
        fastify: 'Fastify',
        typescript: 'TypeScript',
        '@anthropic-ai/sdk': 'Claude API',
        openai: 'OpenAI',
        langchain: 'LangChain',
        prisma: 'Prisma',
        '@vercel/kv': 'Vercel KV',
        tailwindcss: 'Tailwind',
        electron: 'Electron',
        '@tauri-apps/api': 'Tauri'
      };

      for (const [pkg, tech] of Object.entries(techMap)) {
        if (deps[pkg]) techStack.add(tech);
      }
    }

    // Detect by file extensions in cwd
    const files = fs.readdirSync(cwd).slice(0, 50); // Limit scan
    for (const f of files) {
      if (f.endsWith('.ts') || f.endsWith('.tsx')) techStack.add('TypeScript');
      if (f.endsWith('.py')) techStack.add('Python');
      if (f.endsWith('.rs')) techStack.add('Rust');
      if (f.endsWith('.go')) techStack.add('Go');
      if (f.endsWith('.sol')) techStack.add('Solidity');
    }
  } catch (e) {
    // Non-fatal - continue without tech detection
  }

  return Array.from(techStack).slice(0, 8); // Limit to 8 techs
}

/**
 * Send personalized welcome from @vibe (non-blocking)
 */
async function sendPersonalizedWelcome(handle, oneLiner) {
  try {
    const repoName = detectRepoName();
    const techStack = detectTechStack();

    // Fire and forget - don't block init completion
    fetch(`${API_BASE}/api/onboarding/personalized-welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        oneLiner,
        repoName,
        techStack,
        githubProfile: null // Could be passed from callback if available
      })
    }).catch(e => {
      console.error('[vibe_init] Personalized welcome failed:', e.message);
    });
  } catch (e) {
    // Non-fatal - continue without personalized welcome
    console.error('[vibe_init] Context detection failed:', e.message);
  }
}

const LOGIN_URL = 'https://www.slashvibe.dev/login';
const API_URL = config.getApiUrl();
const AUTH_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Send welcome message from @vibe
 */
async function sendWelcomeMessage(handle, one_liner) {
  try {
    const response = await fetch(`${API_URL}/api/onboarding/welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, one_liner })
    });
    const result = await response.json();
    return result.success;
  } catch (e) {
    console.error('[vibe_init] Welcome message failed:', e.message);
    return false;
  }
}

const definition = {
  name: 'vibe_init',
  description:
    'Set your identity for /vibe. Opens browser for GitHub auth and waits for completion. Returns when auth is done.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Custom handle (optional - defaults to your GitHub username)'
      },
      one_liner: {
        type: 'string',
        description: 'What are you building? (one line)'
      }
    },
    required: []
  }
};

/**
 * Open URL in default browser
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, err => {
    if (err) {
      console.error('[vibe_init] Failed to open browser:', err.message);
    }
  });
}

/**
 * Wait for OAuth callback - returns Promise that resolves with handle when auth completes
 */
function waitForCallback(requestedHandle, one_liner) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

      // Handle callback
      if (url.pathname === '/callback') {
        const token = url.searchParams.get('token');
        const callbackHandle = url.searchParams.get('handle');

        if (token && callbackHandle) {
          // Save the token and handle
          const finalHandle = requestedHandle || callbackHandle;

          // Save to config
          config.savePrivyToken(token);
          config.setSessionIdentity(finalHandle, one_liner || '');

          // Update shared config
          const cfg = config.load();
          cfg.handle = finalHandle;
          cfg.one_liner = one_liner || '';
          cfg.authMethod = 'browser';
          cfg.pendingAuth = false;
          config.save(cfg);

          // Register session with API
          const sessionId = config.getSessionId();
          await store.registerSession(sessionId, finalHandle, one_liner);

          // Send initial heartbeat
          await store.heartbeat(finalHandle, one_liner);

          // Post to Discord
          discord.postJoin(finalHandle, one_liner);

          // Send personalized welcome from @vibe (non-blocking)
          sendPersonalizedWelcome(finalHandle, one_liner);

          // Send success response to browser - lightweight, no infinite animations
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to /vibe!</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --neon-green: #00FF88;
      --neon-cyan: #00FFFF;
      --deep-black: #0A0A0A;
      --glow-green: 0 0 15px #00FF88;
    }

    body {
      font-family: 'VT323', monospace;
      background: var(--deep-black);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      overflow: hidden;
      position: relative;
    }

    /* Static CRT Scanline Effect - no animation */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.1),
        rgba(0, 0, 0, 0.1) 1px,
        transparent 1px,
        transparent 2px
      );
      pointer-events: none;
      z-index: 1000;
    }

    /* Static vignette */
    body::after {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: radial-gradient(ellipse at center, transparent 0%, rgba(0, 0, 0, 0.3) 100%);
      pointer-events: none;
      z-index: 999;
    }

    /* Static decorative symbols - NO animation */
    .particles {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 1;
      opacity: 0.15;
    }

    .particle {
      position: absolute;
      font-size: 20px;
      color: var(--neon-green);
    }

    .container {
      background: rgba(0, 255, 136, 0.03);
      border: 2px solid var(--neon-green);
      padding: 48px 64px;
      max-width: 480px;
      width: 90%;
      text-align: center;
      position: relative;
      z-index: 10;
      box-shadow: var(--glow-green);
      animation: fadeIn 0.4s ease-out forwards;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    /* Corner decorations */
    .container::before, .container::after {
      content: '+';
      position: absolute;
      font-family: 'VT323', monospace;
      font-size: 24px;
      color: var(--neon-green);
    }
    .container::before { top: 8px; left: 12px; }
    .container::after { bottom: 8px; right: 12px; }

    .logo {
      font-family: 'Press Start 2P', cursive;
      font-size: 28px;
      color: var(--neon-green);
      text-shadow: var(--glow-green);
      margin-bottom: 24px;
    }

    .checkmark {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
    }

    .checkmark svg {
      width: 100%;
      height: 100%;
      fill: none;
      stroke: var(--neon-green);
      stroke-width: 4;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 8px var(--neon-green));
      animation: drawCheck 0.5s ease-out forwards;
    }

    @keyframes drawCheck {
      0% { stroke-dasharray: 100; stroke-dashoffset: 100; }
      100% { stroke-dasharray: 100; stroke-dashoffset: 0; }
    }

    .welcome {
      font-size: 28px;
      color: rgba(255, 255, 255, 0.9);
      margin-bottom: 8px;
    }

    .handle {
      color: var(--neon-green);
      text-shadow: 0 0 10px var(--neon-green);
    }

    .status {
      font-size: 20px;
      color: var(--neon-cyan);
      margin: 20px 0;
    }

    .close-msg {
      font-size: 18px;
      color: rgba(255, 255, 255, 0.6);
      margin-top: 24px;
      padding: 12px 20px;
      border: 1px dashed rgba(255, 255, 255, 0.3);
    }

    .ascii {
      font-size: 14px;
      color: rgba(0, 255, 136, 0.3);
      margin-top: 20px;
    }

    /* Respect reduced motion preference */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    }

    /* Stop all animations after load */
    .animations-stopped *,
    .animations-stopped *::before,
    .animations-stopped *::after {
      animation: none !important;
    }
  </style>
</head>
<body>
  <div class="particles" id="particles"></div>

  <div class="container">
    <div class="logo">/vibe</div>

    <div class="checkmark">
      <svg viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="22" stroke-opacity="0.3"/>
        <path d="M14 27l8 8 16-16"/>
      </svg>
    </div>

    <p class="welcome">Welcome, <span class="handle">@${finalHandle}</span></p>
    <p class="status">Authentication successful</p>

    <p class="close-msg">You can now close this window</p>

    <div class="ascii">═══════════════════════════════</div>
  </div>

  <script>
    // Create STATIC decorative symbols (no animation)
    (function() {
      var container = document.getElementById('particles');
      var symbols = ['>', '<', '/', '*', '#', '@', '~'];
      var positions = [
        {x: 10, y: 15}, {x: 85, y: 20}, {x: 20, y: 75}, {x: 75, y: 80},
        {x: 50, y: 10}, {x: 15, y: 45}, {x: 88, y: 55}, {x: 45, y: 85}
      ];
      positions.forEach(function(pos, i) {
        var particle = document.createElement('div');
        particle.className = 'particle';
        particle.textContent = symbols[i % symbols.length];
        particle.style.left = pos.x + '%';
        particle.style.top = pos.y + '%';
        container.appendChild(particle);
      });
    })();

    // Stop any remaining animations after 2 seconds (safety net)
    setTimeout(function() {
      document.body.classList.add('animations-stopped');
    }, 2000);
  </script>
</body>
</html>`);

          // Close server and resolve
          resolved = true;
          setTimeout(() => server.close(), 500);
          resolve({ success: true, handle: finalHandle });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing token or handle');
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('AUTH_IN_PROGRESS'));
      } else {
        reject(err);
      }
    });

    // Start server
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`[vibe_init] Callback server listening on port ${CALLBACK_PORT}`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!resolved) {
        server.close();
        reject(new Error('AUTH_TIMEOUT'));
      }
    }, AUTH_TIMEOUT_MS);
  });
}

async function handler(args) {
  const { handle, one_liner, auth_method } = args;

  // Normalize handle if provided
  const h = handle
    ? handle
        .toLowerCase()
        .replace('@', '')
        .replace(/[^a-z0-9_-]/g, '')
    : null;

  // Validate if custom handle provided
  if (h && h.length < 2) {
    return {
      display: 'Handle must be at least 2 characters (letters, numbers, - or _)'
    };
  }

  // Check if already authenticated
  if (config.hasPrivyAuth()) {
    const existingHandle = config.getHandle();
    if (existingHandle) {
      return {
        display: `## Already signed in as @${existingHandle}

To sign out and re-authenticate: \`vibe logout\`
To see who's online: \`vibe who\`
To check messages: \`vibe inbox\``
      };
    }
  }

  // ===========================================
  // Show welcome banner (pre-auth)
  // ===========================================
  const onlineCount = await getOnlineCount();
  const welcomeBanner = generatePreAuthBanner(onlineCount);

  // ===========================================
  // BROWSER AUTH (Default): GitHub OAuth
  // ===========================================
  if (auth_method === 'browser' || !auth_method) {
    // Save one_liner for callback handler
    const cfg = config.load();
    if (h) cfg.handle = h;
    cfg.one_liner = one_liner || '';
    cfg.pendingAuth = true;
    config.save(cfg);

    // Build login URL with redirect to our local callback
    const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`;
    const loginUrl = h
      ? `${LOGIN_URL}?redirect=${encodeURIComponent(callbackUrl)}&handle=${encodeURIComponent(h)}`
      : `${LOGIN_URL}?redirect=${encodeURIComponent(callbackUrl)}`;

    // Open browser BEFORE starting to wait
    openBrowser(loginUrl);

    try {
      // Wait for callback (blocks until auth completes or times out)
      const result = await waitForCallback(h, one_liner);

      // Check for unread messages
      let unreadNotice = '';
      try {
        const unreadCount = await store.getUnreadCount(result.handle);
        if (unreadCount > 0) {
          unreadNotice = `\n\n📬 **${unreadCount} unread messages** — say "check my messages"`;
        }
      } catch (e) {}

      // Generate authenticated banner with handle + unread (3 lines only - won't collapse)
      const authBanner = generateAuthBanner(result.handle, 1, onlineCount);

      return {
        display: authBanner,
        onboarding: {
          isNewUser: true,
          handle: result.handle,
          hint: 'show_onboarding_options'
        }
      };
    } catch (err) {
      if (err.message === 'AUTH_IN_PROGRESS') {
        return {
          display: `## Auth already in progress

Another login flow is running. Complete it in your browser or wait a moment and try again.`
        };
      }

      if (err.message === 'AUTH_TIMEOUT') {
        return {
          display: `## Auth timed out

The login flow wasn't completed within 2 minutes. Try again with \`vibe init\``
        };
      }

      return {
        display: `## Failed to authenticate

Error: ${err.message}

Try again or use legacy auth: \`vibe init --auth_method=legacy\``
      };
    }
  }

  // ===========================================
  // LEGACY AUTH: Local Ed25519 keypairs
  // ===========================================
  const crypto = require('../crypto');

  // Generate Ed25519 keypair if not already present
  let keypair = config.getKeypair();
  let keypairNote = '';
  if (!keypair) {
    keypair = crypto.generateKeypair();
    config.saveKeypair(keypair);
    keypairNote = '\n🔐 _AIRC keypair generated for message signing_';
  }

  // Save identity
  config.setSessionIdentity(h, one_liner || '', keypair);

  const cfg = config.load();
  cfg.handle = h;
  cfg.one_liner = one_liner || '';
  cfg.visible = true;
  cfg.authMethod = 'legacy';
  config.save(cfg);

  // Register session with API
  const sessionId = config.getSessionId();
  const registration = await store.registerSession(sessionId, h, one_liner, keypair.publicKey);

  if (!registration.success) {
    return {
      display: `## Identity Set (Local Only)

**@${h}**
_${one_liner}_

⚠️ Session registration failed: ${registration.error}
Local config saved. Heartbeats will use username fallback.`
    };
  }

  // Send initial heartbeat
  await store.heartbeat(h, one_liner);

  // Post to Discord
  discord.postJoin(h, one_liner);

  // Send personalized welcome from @vibe (non-blocking)
  sendPersonalizedWelcome(h, one_liner);

  // Check for unread messages
  let unreadNotice = '';
  try {
    const unreadCount = await store.getUnreadCount(h);
    if (unreadCount > 0) {
      unreadNotice = `\n\n📬 **NEW MESSAGE — ${unreadCount} UNREAD** — say "check my messages"`;
    }
  } catch (e) {}

  return {
    display: `${welcomeBanner}
## Welcome to /vibe! (Legacy Auth)

**@${h}**
_${one_liner}_${unreadNotice}${keypairNote}

📨 **Check your messages** — @vibe sent you a personalized welcome!

⚠️ **Using local keys** — consider upgrading to GitHub auth:
\`vibe init\` — Sign in with GitHub for verified identity

### Onboarding Checklist
[ ] Read your welcome message from @vibe
[ ] Reply to @vibe
[ ] Message one recommended builder
[ ] Post your first ship
[ ] Leave some feedback

_Say "vibe onboarding" anytime to check your progress_`
  };
}

module.exports = { definition, handler };
