/**
 * vibe_l2 - Unified VIBE L2 Command
 *
 * One command to rule them all.
 *
 * Examples:
 * - "vibe l2"              - Overview and status
 * - "vibe l2 status"       - Chain health
 * - "vibe l2 shipback"     - View earnings
 * - "vibe l2 bridge"       - Bridge info
 * - "vibe l2 mint"         - Mint artifact on L2
 */

const config = require('../config');

const definition = {
  name: 'vibe_l2',
  description: 'VIBE L2 commands: status, shipback, bridge, mint. Run "vibe l2" for overview.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command: status, shipback, bridge, mint, or omit for overview'
      },
      args: {
        type: 'object',
        description: 'Arguments for the command'
      }
    }
  }
};

async function handler(args) {
  const { command, args: cmdArgs = {} } = args;

  if (!config.isInitialized()) {
    return {
      display: 'Run `vibe init` first to set your identity.'
    };
  }

  const handle = config.getHandle();

  // No command = show overview
  if (!command) {
    return showOverview(handle);
  }

  // Route to specific tool
  switch (command.toLowerCase()) {
    case 'status':
      const statusTool = require('./l2-status');
      return statusTool.handler(cmdArgs);

    case 'shipback':
    case 'earnings':
      const shipbackTool = require('./shipback');
      return shipbackTool.handler(cmdArgs);

    case 'bridge':
      const bridgeTool = require('./l2-bridge');
      return bridgeTool.handler(cmdArgs);

    case 'mint':
      return showMintInfo(handle);

    case 'help':
      return showHelp();

    default:
      return {
        display: `Unknown command: ${command}\n\nRun "vibe l2 help" for available commands.`
      };
  }
}

function showOverview(handle) {
  return {
    display: `
╔═══════════════════════════════════════════════════════════════════╗
║                         VIBE L2                                    ║
║           Creator-First Economics for the AI Coding Era           ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║   "You shipped it, you earn from it"                              ║
║                                                                    ║
║   VIBE L2 is an OP Stack chain where creators earn 80% of         ║
║   gas fees from interactions with their deployed contracts.       ║
║                                                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║   SHIPBACK ECONOMICS                                               ║
║   ┌──────────────────────────────────────────────────────────┐    ║
║   │  User interacts with your artifact                       │    ║
║   │              ↓                                           │    ║
║   │  Gas fee collected → Distributed:                        │    ║
║   │                                                          │    ║
║   │  ████████████████████░░░░░  80% → You (Creator)         │    ║
║   │  ███░░░░░░░░░░░░░░░░░░░░░░  15% → Protocol Treasury     │    ║
║   │  █░░░░░░░░░░░░░░░░░░░░░░░░   5% → Foundation Grants     │    ║
║   └──────────────────────────────────────────────────────────┘    ║
║                                                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║   COMMANDS                                                         ║
║   ────────────────────────────────────────────────────────────    ║
║   vibe l2 status      Check chain health & contracts              ║
║   vibe l2 shipback    View/claim your earnings                    ║
║   vibe l2 bridge      Move ETH between Base ↔ VIBE L2             ║
║   vibe l2 mint        Mint an artifact on VIBE L2                 ║
║                                                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║   QUICK START                                                      ║
║   1. Bridge ETH:     vibe l2 bridge deposit 0.1                   ║
║   2. Link wallet:    vibe l2 shipback link                        ║
║   3. Create art:     vibe create artifact                         ║
║   4. Mint on L2:     vibe l2 mint                                 ║
║   5. Earn forever:   vibe l2 shipback                             ║
║                                                                    ║
╚═══════════════════════════════════════════════════════════════════╝

Logged in as: @${handle}
`.trim()
  };
}

function showMintInfo(handle) {
  return {
    display: `
🎨 MINT ON VIBE L2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Minting on VIBE L2 gives you:
• 80% of all gas fees from interactions (Shipback)
• Ultra-low minting costs (~0.0001 ETH)
• Session provenance on-chain
• Automatic royalties (10% default)

To mint an artifact:

1. First, create the artifact content:
   vibe create artifact

2. Then mint it on VIBE L2:
   vibe mint --chain vibe-l2

Or use the API directly:
   POST /api/nft/mint
   {
     "artifact_id": "art_xxx",
     "chain": "vibe-l2"
   }

Prerequisites:
• ETH on VIBE L2 (use: vibe l2 bridge deposit 0.1)
• Linked wallet (use: vibe l2 shipback link)

Current handle: @${handle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim()
  };
}

function showHelp() {
  return {
    display: `
VIBE L2 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

vibe l2                    Show this overview
vibe l2 status             Chain health, contracts, gas prices
vibe l2 shipback           View Shipback earnings
vibe l2 shipback link      Link wallet to handle
vibe l2 shipback claim     Claim accumulated earnings
vibe l2 shipback contracts List registered contracts
vibe l2 bridge             Bridge overview
vibe l2 bridge deposit X   Deposit X ETH to VIBE L2
vibe l2 bridge withdraw X  Withdraw X ETH to Base
vibe l2 bridge estimate    Gas cost estimates
vibe l2 mint               Mint artifact info

ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Ethereum   │────▶│    Base     │────▶│   VIBE L2   │
│ (Security)  │     │  (Bridge)   │     │   (Apps)    │
└─────────────┘     └─────────────┘     └─────────────┘

Stack: OP Stack via Conduit
DA: Celestia
Gas: ETH (not token)

LINKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Explorer: https://explorer.vibe.network
Bridge:   https://bridge.vibe.network
Docs:     https://docs.slashvibe.dev/l2
`.trim()
  };
}

module.exports = { definition, handler };
