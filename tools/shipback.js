/**
 * vibe_shipback - View and Claim Shipback Earnings
 *
 * "You shipped it, you earn from it"
 *
 * Shipback gives creators 80% of gas fees from interactions
 * with their deployed contracts on VIBE L2.
 *
 * Examples:
 * - "vibe shipback"          - View your earnings
 * - "vibe shipback balance"  - Check pending balance
 * - "vibe shipback claim"    - Initiate a claim
 * - "vibe shipback link"     - Link wallet to handle
 */

const fetch = require('node-fetch');
const config = require('../config');

const definition = {
  name: 'vibe_shipback',
  description: 'View and claim Shipback earnings. Creators earn 80% of gas fees from their contracts on VIBE L2.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: balance, claim, link, contracts (default: balance)'
      },
      wallet_address: {
        type: 'string',
        description: 'Wallet address (for link action)'
      },
      signature: {
        type: 'string',
        description: 'Signed message (for link/claim actions)'
      },
      nonce: {
        type: 'string',
        description: 'Nonce from the signing step (required for link/claim verification)'
      }
    }
  }
};

async function handler(args) {
  const { action = 'balance', wallet_address, signature, nonce } = args;

  if (!config.isInitialized()) {
    return {
      display: 'Run `vibe init` first to set your identity.'
    };
  }

  const handle = config.getHandle();
  const apiUrl = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

  try {
    switch (action) {
      case 'balance':
        return await getBalance(apiUrl, handle);

      case 'contracts':
        return await getContracts(apiUrl, handle);

      case 'link':
        return await linkWallet(apiUrl, handle, wallet_address, signature, nonce);

      case 'claim':
        return await initiateClaim(apiUrl, handle, signature, nonce);

      default:
        return {
          display: `Unknown action: ${action}\n\nValid actions: balance, claim, link, contracts`
        };
    }
  } catch (error) {
    return {
      display: `❌ Failed to process Shipback request: ${error.message}`
    };
  }
}

/**
 * Get Shipback balance
 */
async function getBalance(apiUrl, handle) {
  const response = await fetch(`${apiUrl}/api/shipback/balance?handle=${handle}`);
  const data = await response.json();

  if (!response.ok) {
    return {
      display: `❌ ${data.error || 'Failed to fetch balance'}`
    };
  }

  const pendingEth = parseFloat(data.pendingBalanceEth || 0);
  const totalEth = parseFloat(data.totalEarnedEth || 0);
  const claimedEth = parseFloat(data.totalClaimedEth || 0);

  const statusIcon = data.canClaim ? '🟢' : '🟡';
  const claimNote = data.canClaim
    ? 'Ready to claim!'
    : pendingEth < parseFloat(data.minClaimAmountEth || 0.001)
      ? `Min claim: ${data.minClaimAmountEth} ETH`
      : 'Cooldown active';

  const formatted = `
┌────────────────────────────────────────────────────────────┐
│                    💰 SHIPBACK EARNINGS                    │
│            "You shipped it, you earn from it"              │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Handle: @${handle.padEnd(46)} │
│  Wallet: ${(data.wallet || 'not linked').substring(0, 46).padEnd(46)} │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Pending:  ${pendingEth.toFixed(6).padEnd(12)} ETH  ${statusIcon} ${claimNote.padEnd(24)} │
│  Earned:   ${totalEth.toFixed(6).padEnd(12)} ETH  (lifetime)                │
│  Claimed:  ${claimedEth.toFixed(6).padEnd(12)} ETH                          │
│                                                            │
│  Contracts: ${String(data.contractCount || 0).padEnd(45)} │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Distribution: 80% creator │ 15% protocol │ 5% foundation │
└────────────────────────────────────────────────────────────┘
`.trim();

  return { display: formatted, data };
}

/**
 * Get registered contracts
 */
async function getContracts(apiUrl, handle) {
  const response = await fetch(`${apiUrl}/api/shipback/balance?handle=${handle}`);
  const data = await response.json();

  if (!response.ok) {
    return {
      display: `❌ ${data.error || 'Failed to fetch contracts'}`
    };
  }

  const contracts = data.contracts || [];

  if (contracts.length === 0) {
    return {
      display: `No contracts registered for Shipback.

To register a contract:
1. Deploy your artifact contract to VIBE L2
2. Link your wallet: vibe shipback link
3. Register the contract via the API

Your deployed contracts will earn 80% of all gas fees!`
    };
  }

  let formatted = `📜 REGISTERED CONTRACTS (${contracts.length})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

  contracts.forEach((c, i) => {
    const addr = c.address || '';
    formatted += `${i + 1}. ${addr.substring(0, 10)}...${addr.substring(36)}
   Type: ${c.type || 'artifact'}
   Earned: ${c.earned || '0'} wei
   Registered: ${c.registeredAt ? new Date(c.registeredAt).toLocaleDateString() : 'unknown'}

`;
  });

  return { display: formatted.trim(), contracts };
}

/**
 * Link wallet to handle (generates signing message)
 */
async function linkWallet(apiUrl, handle, walletAddress, signature, nonce) {
  if (!walletAddress) {
    const generatedNonce = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const timestamp = Date.now();
    const message = `I am linking my wallet to VIBE handle @${handle}\n\nNonce: ${generatedNonce}\nTimestamp: ${timestamp}`;

    return {
      display: `🔗 LINK WALLET TO @${handle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sign this message with your wallet:

"${message}"

Then run:
vibe shipback link --wallet_address=YOUR_WALLET --signature=YOUR_SIGNATURE --nonce=${generatedNonce}`,
      signMessage: message,
      nonce: generatedNonce
    };
  }

  if (!signature) {
    return {
      display: 'Signature required. Sign the message from the previous step.'
    };
  }

  if (!nonce) {
    return {
      display: 'Nonce required. Include --nonce=NONCE from the signing step.'
    };
  }

  const response = await fetch(`${apiUrl}/api/shipback/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'link',
      handle,
      walletAddress,
      signature,
      nonce
    })
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      display: `❌ ${data.error || 'Failed to link wallet'}`
    };
  }

  return {
    display: `✅ WALLET LINKED!

Handle: @${handle}
Wallet: ${walletAddress}

You can now:
- Register contracts for Shipback
- Claim accumulated earnings
- Earn 80% of gas fees from your contracts`
  };
}

/**
 * Initiate a claim
 */
async function initiateClaim(apiUrl, handle, signature, nonce) {
  // First check balance
  const balanceResp = await fetch(`${apiUrl}/api/shipback/balance?handle=${handle}`);
  const balanceData = await balanceResp.json();

  if (!balanceData.canClaim) {
    const reason = parseFloat(balanceData.pendingBalanceEth) < parseFloat(balanceData.minClaimAmountEth)
      ? `Balance (${balanceData.pendingBalanceEth} ETH) below minimum (${balanceData.minClaimAmountEth} ETH)`
      : `Cooldown active until ${balanceData.cooldownEndsAt}`;

    return {
      display: `❌ Cannot claim yet: ${reason}

Current balance: ${balanceData.pendingBalanceEth} ETH`
    };
  }

  if (!signature) {
    const generatedNonce = `claim-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const message = `Claim Shipback for @${handle}\n\nNonce: ${generatedNonce}`;

    return {
      display: `💰 CLAIM ${balanceData.pendingBalanceEth} ETH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sign this message to claim:

"${message}"

Then run:
vibe shipback claim --signature=YOUR_SIGNATURE --nonce=${generatedNonce}`,
      signMessage: message,
      nonce: generatedNonce,
      claimable: balanceData.pendingBalanceEth
    };
  }

  if (!nonce) {
    return {
      display: 'Nonce required. Include --nonce=NONCE from the signing step.'
    };
  }

  const response = await fetch(`${apiUrl}/api/shipback/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle,
      signature,
      nonce
    })
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      display: `❌ ${data.error || 'Failed to initiate claim'}`
    };
  }

  return {
    display: `✅ CLAIM INITIATED

Claim ID: ${data.claimId}
Amount: ${data.claimAmountEth} ETH
Wallet: ${data.wallet}

Next steps:
${data.instructions?.map((i, idx) => `${idx + 1}. ${i}`).join('\n') || 'Submit transaction to ShipbackRegistry'}

Contract: ${data.registryAddress}
Chain: VIBE L2 (${data.chainId})`
  };
}

module.exports = { definition, handler };
