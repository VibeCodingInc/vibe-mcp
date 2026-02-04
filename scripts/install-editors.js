#!/usr/bin/env node
/**
 * Universal multi-editor installer for /vibe MCP server.
 *
 * Detects installed editors and configures MCP settings for each.
 * Usage: npx slashvibe-mcp install
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const VIBE_SERVER = {
  command: 'npx',
  args: ['-y', 'slashvibe-mcp']
};

// Editor config locations and formats
const EDITORS = [
  {
    name: 'Claude Code',
    detect: () => commandExists('claude'),
    configPaths: [
      path.join(HOME, '.claude.json'),
      path.join(HOME, '.config', 'claude-code', 'mcp.json')
    ],
    format: 'mcpServers',
    key: 'vibe'
  },
  {
    name: 'Cursor',
    detect: () => {
      const cursorDir = path.join(HOME, '.cursor');
      return fs.existsSync(cursorDir);
    },
    configPaths: [
      path.join(HOME, '.cursor', 'mcp.json')
    ],
    format: 'mcpServers',
    key: 'vibe'
  },
  {
    name: 'VS Code',
    detect: () => {
      if (IS_MAC) return fs.existsSync(path.join(HOME, 'Library', 'Application Support', 'Code'));
      if (IS_LINUX) return fs.existsSync(path.join(HOME, '.config', 'Code'));
      if (IS_WIN) return fs.existsSync(path.join(HOME, 'AppData', 'Roaming', 'Code'));
      return false;
    },
    configPaths: (() => {
      if (IS_MAC) return [path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json')];
      if (IS_LINUX) return [path.join(HOME, '.config', 'Code', 'User', 'settings.json')];
      if (IS_WIN) return [path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'settings.json')];
      return [];
    })(),
    format: 'vscode',
    key: 'vibe'
  },
  {
    name: 'Windsurf',
    detect: () => {
      const windsurfConfig = path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json');
      const windsurfDir = path.join(HOME, '.codeium', 'windsurf');
      return fs.existsSync(windsurfDir);
    },
    configPaths: [
      path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json')
    ],
    format: 'mcpServers',
    key: 'vibe'
  },
  {
    name: 'Cline',
    detect: () => {
      // Cline stores config in VS Code's extension directory
      if (IS_MAC) {
        const ext = path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
        return fs.existsSync(ext);
      }
      return false;
    },
    configPaths: (() => {
      if (IS_MAC) return [path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')];
      return [];
    })(),
    format: 'mcpServers',
    key: 'vibe'
  },
  {
    name: 'Continue.dev',
    detect: () => fs.existsSync(path.join(HOME, '.continue')),
    configPaths: [
      path.join(HOME, '.continue', 'mcpServers', 'vibe.json')
    ],
    format: 'standalone',
    key: 'vibe'
  }
];

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function configureEditor(editor) {
  const configPath = editor.configPaths[0];
  if (!configPath) return { status: 'skip', reason: 'no config path' };

  ensureDir(configPath);

  if (editor.format === 'standalone') {
    // Continue.dev: one file per server
    fs.writeFileSync(configPath, JSON.stringify(VIBE_SERVER, null, 2) + '\n');
    return { status: 'configured', path: configPath };
  }

  if (editor.format === 'vscode') {
    // VS Code: nested under mcp.servers in settings.json
    let config = readJsonSafe(configPath) || {};
    if (!config.mcp) config.mcp = {};
    if (!config.mcp.servers) config.mcp.servers = {};

    if (config.mcp.servers.vibe) {
      return { status: 'exists', path: configPath };
    }

    config.mcp.servers.vibe = VIBE_SERVER;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    return { status: 'configured', path: configPath };
  }

  // Default: mcpServers format (Claude Code, Cursor, Windsurf, Cline)
  let config = readJsonSafe(configPath) || {};
  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers.vibe) {
    return { status: 'exists', path: configPath };
  }

  config.mcpServers.vibe = VIBE_SERVER;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { status: 'configured', path: configPath };
}

function trackInstallEvent(editor, status) {
  // Fire-and-forget anonymous install tracking
  try {
    const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
    fetch(`${API_URL}/api/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'editor_install',
        data: {
          editor,
          status,
          platform: process.platform,
          node: process.version,
          client: 'installer',
          timestamp: Date.now()
        }
      })
    }).catch(() => {});
  } catch (e) {}
}

// Main
function run() {
  console.log('\n/vibe MCP installer\n');

  const detected = [];
  const notFound = [];

  for (const editor of EDITORS) {
    if (editor.detect()) {
      detected.push(editor);
    } else {
      notFound.push(editor);
    }
  }

  if (detected.length === 0) {
    console.log('No supported editors detected.\n');
    console.log('Supported: Claude Code, Cursor, VS Code, Windsurf, Cline, Continue.dev\n');
    console.log('Manual setup: https://github.com/VibeCodingInc/vibe-mcp#install\n');
    process.exit(0);
  }

  console.log(`Found ${detected.length} editor${detected.length > 1 ? 's' : ''}:\n`);

  let configured = 0;
  let alreadyDone = 0;
  let errors = 0;

  for (const editor of detected) {
    try {
      const result = configureEditor(editor);
      if (result.status === 'configured') {
        console.log(`  + ${editor.name} — configured`);
        console.log(`    ${result.path}`);
        trackInstallEvent(editor.name, 'configured');
        configured++;
      } else if (result.status === 'exists') {
        console.log(`  = ${editor.name} — already configured`);
        trackInstallEvent(editor.name, 'exists');
        alreadyDone++;
      } else {
        console.log(`  - ${editor.name} — skipped (${result.reason})`);
      }
    } catch (e) {
      console.log(`  ! ${editor.name} — error: ${e.message}`);
      trackInstallEvent(editor.name, 'error');
      errors++;
    }
  }

  console.log('');

  if (configured > 0) {
    console.log(`Configured ${configured} editor${configured > 1 ? 's' : ''}. Restart them to activate /vibe.\n`);
  }
  if (alreadyDone > 0) {
    console.log(`${alreadyDone} editor${alreadyDone > 1 ? 's' : ''} already had /vibe configured.\n`);
  }

  console.log('Next steps:');
  console.log('  1. Restart your editor');
  console.log('  2. Tell your AI: "let\'s vibe"\n');
  console.log('Docs: https://slashvibe.dev');
  console.log('');
}

run();
