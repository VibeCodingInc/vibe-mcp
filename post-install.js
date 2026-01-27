#!/usr/bin/env node

/**
 * Post-install script for slashvibe-mcp
 * Sets up MCP server configuration and CLAUDE.md for Claude Code
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = homedir();
const CLAUDE_CONFIG_DIR = path.join(HOME, '.config', 'claude-code');
const MCP_CONFIG_PATH = path.join(CLAUDE_CONFIG_DIR, 'mcp.json');
const CLAUDE_MD_DIR = path.join(HOME, '.claude');
const CLAUDE_MD_PATH = path.join(CLAUDE_MD_DIR, 'CLAUDE.md');
const VIBE_MARKER = '## /vibe - Terminal-Native Social';

async function setup() {
  console.log('\n📦 Setting up /vibe...\n');

  try {
    // Ensure config directory exists
    await fs.mkdir(CLAUDE_CONFIG_DIR, { recursive: true });
    await fs.mkdir(CLAUDE_MD_DIR, { recursive: true });

    // Read existing MCP config or create new
    let config = { mcpServers: {} };
    try {
      const existing = await fs.readFile(MCP_CONFIG_PATH, 'utf-8');
      config = JSON.parse(existing);
      if (!config.mcpServers) config.mcpServers = {};
    } catch (error) {
      // File doesn't exist, use default
    }

    // Use npx to run slashvibe-mcp — works regardless of install location
    config.mcpServers.vibe = {
      command: 'npx',
      args: ['-y', 'slashvibe-mcp']
    };

    // Write config
    await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));

    // Inject CLAUDE.md template for dashboard mode
    await injectClaudeMd();

    console.log('✅ /vibe MCP server configured\n');
    console.log('Next steps:');
    console.log('  1. Restart Claude Code');
    console.log('  2. Run: vibe init @yourusername\n');
    console.log('📖 Docs: https://slashvibe.dev\n');

  } catch (error) {
    console.error('⚠️  Setup incomplete:', error.message);
    console.error('\nManual setup:');
    console.error('  Add to ~/.config/claude-code/mcp.json:\n');
    console.error('  {');
    console.error('    "mcpServers": {');
    console.error('      "vibe": {');
    console.error('        "command": "npx",');
    console.error('        "args": ["-y", "slashvibe-mcp"]');
    console.error('      }');
    console.error('    }');
    console.error('  }\n');
  }
}

/**
 * Inject /vibe CLAUDE.md template for dashboard mode and hint handling
 * - If CLAUDE.md doesn't exist, create it with template
 * - If exists but no /vibe section, append template
 * - If /vibe section exists, update it with latest template
 */
async function injectClaudeMd() {
  try {
    // Find the template relative to this script
    // When installed via npm: ../dashboard/VIBE_CLAUDE_MD_TEMPLATE.md
    const templatePath = path.join(__dirname, '..', 'dashboard', 'VIBE_CLAUDE_MD_TEMPLATE.md');

    let template;
    try {
      template = await fs.readFile(templatePath, 'utf-8');
    } catch (e) {
      // Template not found (might be dev environment), skip injection
      console.log('ℹ️  CLAUDE.md template not found, skipping dashboard setup');
      return;
    }

    // Check if CLAUDE.md exists
    let existingContent = '';
    try {
      existingContent = await fs.readFile(CLAUDE_MD_PATH, 'utf-8');
    } catch (e) {
      // File doesn't exist, will create new
    }

    if (existingContent.includes(VIBE_MARKER)) {
      // /vibe section exists - replace it with updated template
      // Find the section and replace it
      const startIndex = existingContent.indexOf(VIBE_MARKER);

      // Find the next ## header (or end of file)
      const afterMarker = existingContent.substring(startIndex + VIBE_MARKER.length);
      const nextSectionMatch = afterMarker.match(/\n## (?!\/vibe)/);

      let endIndex;
      if (nextSectionMatch) {
        endIndex = startIndex + VIBE_MARKER.length + nextSectionMatch.index;
      } else {
        endIndex = existingContent.length;
      }

      // Replace the section
      const beforeSection = existingContent.substring(0, startIndex);
      const afterSection = existingContent.substring(endIndex);
      const newContent = beforeSection + template + afterSection;

      await fs.writeFile(CLAUDE_MD_PATH, newContent);
      console.log('✅ CLAUDE.md updated with latest /vibe dashboard');
    } else if (existingContent) {
      // CLAUDE.md exists but no /vibe section - append
      const newContent = existingContent + '\n\n' + template;
      await fs.writeFile(CLAUDE_MD_PATH, newContent);
      console.log('✅ /vibe dashboard added to CLAUDE.md');
    } else {
      // No CLAUDE.md - create with template
      await fs.writeFile(CLAUDE_MD_PATH, template);
      console.log('✅ CLAUDE.md created with /vibe dashboard');
    }
  } catch (error) {
    // Non-fatal - log but don't fail installation
    console.log('ℹ️  Could not update CLAUDE.md:', error.message);
  }
}

setup();
