/**
 * vibe_l2_status - VIBE L2 Chain Health
 *
 * Check the status of VIBE L2 chain, contracts, and infrastructure.
 * Shows: chain health, block height, gas prices, contract status.
 *
 * Examples:
 * - "vibe l2 status"
 * - "check chain health"
 * - "is vibe l2 running"
 */

const fetch = require('node-fetch');

// Chain configuration (matches lib/vibe-l2/config.js)
const CHAINS = {
  'vibe-l2': {
    chainId: 84532000, // Mainnet
    name: 'VIBE L2',
    rpcUrl: process.env.VIBE_L2_RPC || 'https://rpc.vibe.network',
    explorerUrl: 'https://explorer.vibe.network'
  },
  'vibe-l2-testnet': {
    chainId: 84532001, // Testnet
    name: 'VIBE L2 Testnet',
    rpcUrl: process.env.VIBE_L2_TESTNET_RPC || 'https://rpc-testnet.vibe.network',
    explorerUrl: 'https://explorer-testnet.vibe.network'
  }
};

const definition = {
  name: 'vibe_l2_status',
  description: 'Check VIBE L2 chain health: block height, gas prices, contract status, Shipback registry.',
  inputSchema: {
    type: 'object',
    properties: {
      network: {
        type: 'string',
        description: 'Network to check: vibe-l2, vibe-l2-testnet (default: testnet)'
      },
      verbose: {
        type: 'boolean',
        description: 'Show detailed contract status'
      }
    }
  }
};

async function handler(args) {
  const { network = 'vibe-l2-testnet', verbose = false } = args;
  try {
    const chain = CHAINS[network];
    if (!chain) {
      return {
        success: false,
        error: `Unknown network: ${network}`,
        available: Object.keys(CHAINS)
      };
    }

    // Check RPC health
    const rpcStatus = await checkRpcHealth(chain.rpcUrl);

    // Get contract addresses from environment
    // Standardized format: VIBE_ARTIFACTS_TESTNET or VIBE_ARTIFACTS_MAINNET
    const envSuffix = network === 'vibe-l2' ? 'MAINNET' : 'TESTNET';
    const contracts = {
      vibeArtifacts: process.env[`VIBE_ARTIFACTS_${envSuffix}`],
      shipbackRegistry: process.env[`SHIPBACK_REGISTRY_${envSuffix}`],
      vibeToken: process.env[`VIBE_TOKEN_${envSuffix}`]
    };

    // Check Shipback API health
    const apiUrl = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
    let apiHealth = { status: 'unknown' };
    try {
      const apiResp = await fetch(`${apiUrl}/api/health?full=true`, { timeout: 5000 });
      apiHealth = await apiResp.json();
    } catch (e) {
      apiHealth = { status: 'error', error: e.message };
    }

    // Build status report
    const status = {
      network: chain.name,
      chainId: chain.chainId,
      rpc: {
        url: chain.rpcUrl,
        ...rpcStatus
      },
      contracts: {
        vibeArtifacts: contracts.vibeArtifacts || 'not deployed',
        shipbackRegistry: contracts.shipbackRegistry || 'not deployed',
        vibeToken: contracts.vibeToken || 'not deployed (optional)'
      },
      api: apiHealth.status === 'healthy' ? 'healthy' : apiHealth.status,
      explorer: chain.explorerUrl
    };

    // Format output
    const rpcIcon = rpcStatus.healthy ? '🟢' : '🔴';
    const apiIcon = apiHealth.status === 'healthy' ? '🟢' : '🟡';

    let formatted = `
┌─────────────────────────────────────────────────────┐
│              VIBE L2 STATUS                         │
├─────────────────────────────────────────────────────┤
│ Network: ${chain.name.padEnd(39)} │
│ Chain ID: ${String(chain.chainId).padEnd(38)} │
├─────────────────────────────────────────────────────┤
│ RPC ${rpcIcon}                                          │
│   Block: ${String(rpcStatus.blockNumber || 'N/A').padEnd(39)} │
│   Gas: ${String(rpcStatus.gasPrice || 'N/A').padEnd(41)} │
├─────────────────────────────────────────────────────┤
│ Contracts                                           │
│   Artifacts: ${(contracts.vibeArtifacts || 'not deployed').substring(0, 35).padEnd(35)} │
│   Shipback:  ${(contracts.shipbackRegistry || 'not deployed').substring(0, 35).padEnd(35)} │
│   Token:     ${(contracts.vibeToken || 'optional').substring(0, 35).padEnd(35)} │
├─────────────────────────────────────────────────────┤
│ API ${apiIcon}  ${apiUrl.padEnd(43)} │
└─────────────────────────────────────────────────────┘
`.trim();

    if (verbose && rpcStatus.healthy) {
      formatted += `\n\nDetailed RPC Info:
  Latest Block: ${rpcStatus.blockNumber}
  Block Time: ${rpcStatus.blockTime || 'unknown'}
  Gas Price: ${rpcStatus.gasPrice} gwei
  Chain ID: ${rpcStatus.chainId}`;
    }

    // Shipback info
    formatted += `\n\n💰 Shipback Distribution: 80% creator / 15% protocol / 5% foundation`;
    formatted += `\n📖 Explorer: ${chain.explorerUrl}`;

    return {
      display: formatted,
      data: status
    };
  } catch (error) {
    return {
      display: `❌ Failed to check L2 status: ${error.message}`
    };
  }
}

/**
 * Check RPC endpoint health
 */
async function checkRpcHealth(rpcUrl) {
  try {
    // eth_blockNumber
    const blockResp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      }),
      timeout: 5000
    });

    const blockData = await blockResp.json();
    const blockNumber = parseInt(blockData.result, 16);

    // eth_gasPrice
    const gasResp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_gasPrice',
        params: [],
        id: 2
      }),
      timeout: 5000
    });

    const gasData = await gasResp.json();
    const gasPrice = parseInt(gasData.result, 16) / 1e9; // Convert to gwei

    // eth_chainId
    const chainResp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
        id: 3
      }),
      timeout: 5000
    });

    const chainData = await chainResp.json();
    const chainId = parseInt(chainData.result, 16);

    return {
      healthy: true,
      blockNumber,
      gasPrice: gasPrice.toFixed(4),
      chainId,
      latency: 'ok'
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message
    };
  }
}

module.exports = { definition, handler };
