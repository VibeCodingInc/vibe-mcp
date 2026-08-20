/**
 * vibe update — Update /vibe to latest version
 *
 * If installed via git: runs git pull
 * If installed via curl: tells user to re-run installer
 * Always reminds to restart Claude Code
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VIBE_DIR = path.join(process.env.HOME, '.vibe');
const REPO_DIR = path.join(VIBE_DIR, 'vibe-repo');
const MCP_DIR = path.join(VIBE_DIR, 'mcp-server');

const definition = {
  name: 'vibe_update',
  description: 'Update /vibe to the latest version. Checks for updates and applies them.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

function getVersion() {
  try {
    const versionFile = path.join(MCP_DIR, 'version.json');
    if (fs.existsSync(versionFile)) {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
      return data.version || 'unknown';
    }
  } catch (e) {}
  return 'unknown';
}

async function handler(args) {
  const currentVersion = getVersion();
  let display = `## /vibe Update\n\n`;
  display += `Current version: **v${currentVersion}**\n\n`;

  // Check if we have a git repo
  const gitDir = path.join(REPO_DIR, '.git');
  const isGitInstall = fs.existsSync(gitDir);

  if (!isGitInstall) {
    // npx / global install (the common case). npx prefers a stale global over
    // fetching latest, so removing the global is what actually pulls the update.
    display += `You're on an **npx/global install**.\n\n`;
    display += `To get the latest:\n`;
    display += `\`\`\`\n`;
    display += `npm rm -g slashvibe-mcp\n`;
    display += `\`\`\`\n`;
    display += `Then **restart Claude Code** — npx will fetch the latest automatically.\n\n`;
    display += `> Heads up: \`npx slashvibe-mcp\` reuses an existing global if one is\n`;
    display += `> installed, so clearing the global is what pulls the new version.\n\n`;
    display += `---\n`;
    display += `⚠️ **After updating: restart Claude Code**`;
    return { display };
  }

  // Git-based install — run git pull
  display += `Checking for updates...\n\n`;

  try {
    // Fetch and check if there are updates
    execSync('git fetch --quiet', { cwd: REPO_DIR, stdio: 'pipe' });

    const localHash = execSync('git rev-parse HEAD', { cwd: REPO_DIR, encoding: 'utf-8' }).trim();
    const remoteHash = execSync('git rev-parse @{u}', { cwd: REPO_DIR, encoding: 'utf-8' }).trim();

    if (localHash === remoteHash) {
      display += `✅ **Already up to date** (v${currentVersion})\n\n`;
      display += `No restart needed.`;
      return { display };
    }

    // There are updates — pull them
    const pullOutput = execSync('git pull --quiet', { cwd: REPO_DIR, encoding: 'utf-8' });

    const newVersion = getVersion();
    display += `✅ **Updated to v${newVersion}**\n\n`;

    // Show what changed (last few commits)
    try {
      const log = execSync('git log --oneline -3', { cwd: REPO_DIR, encoding: 'utf-8' });
      display += `Recent changes:\n\`\`\`\n${log.trim()}\n\`\`\`\n\n`;
    } catch (e) {}

    display += `---\n`;
    display += `⚠️ **Restart Claude Code to apply changes**`;

  } catch (e) {
    display += `❌ **Update failed**\n\n`;
    display += `Error: ${e.message}\n\n`;
    display += `Try manually:\n`;
    display += `\`\`\`\n`;
    display += `cd ~/.vibe/vibe-repo && git pull\n`;
    display += `\`\`\`\n\n`;
    display += `---\n`;
    display += `⚠️ **After fixing: restart Claude Code**`;
  }

  return { display };
}

module.exports = { definition, handler };
