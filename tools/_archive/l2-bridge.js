/**
 * vibe_bridge - Bridge ETH between Base and VIBE L2
 *
 * Move assets to VIBE L2 to mint artifacts and interact with
 * the Shipback economy.
 *
 * Deposit: Base → VIBE L2 (~1 minute)
 * Withdrawal: VIBE L2 → Base (~7 days, or ~1 hour with fast mode)
 *
 * Examples:
 * - "vibe bridge deposit 0.1"    - Move 0.1 ETH to VIBE L2
 * - "vibe bridge status"         - Check bridge status
 * - "vibe bridge withdraw 0.05"  - Move ETH back to Base
 */

const fetch = require('node-fetch');
const config = require('../config');

const definition = {
  name: 'vibe_bridge',
  description: 'Bridge ETH between Base and VIBE L2. Deposit to mint artifacts, withdraw to cash out.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: deposit, withdraw, status, estimate (default: status)'
      },
      amount: {
        type: 'string',
        description: 'Amount in ETH (e.g., "0.1")'
      },
      tx_hash: {
        type: 'string',
        description: 'Transaction hash to check status'
      }
    }
  }
};

async function handler(args) {
  const { action = 'status', amount, tx_hash } = args;

  if (!config.isInitialized()) {
    return {
      display: 'Run `vibe init` first to set your identity.'
    };
  }

  const handle = config.getHandle();

  try {
    switch (action) {
      case 'status':
        return await getBridgeStatus(handle, tx_hash);

      case 'deposit':
        return await initiateDeposit(handle, amount);

      case 'withdraw':
        return await initiateWithdraw(handle, amount);

      case 'estimate':
        return await estimateGas(amount);

      default:
        return {
          display: `Unknown action: ${action}\n\nValid actions: deposit, withdraw, status, estimate`
        };
    }
  } catch (error) {
    return {
      display: `❌ Bridge operation failed: ${error.message}`
    };
  }
}

/**
 * Get bridge status
 */
async function getBridgeStatus(handle, txHash) {
  const formatted = `
┌────────────────────────────────────────────────────────────┐
│                    🌉 VIBE BRIDGE                          │
│               Base ←→ VIBE L2                              │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Deposit (Base → VIBE L2)                                  │
│  ├─ Time: ~1 minute                                        │
│  ├─ Supported: ETH, USDC                                   │
│  └─ Use: Mint artifacts, interact with contracts           │
│                                                            │
│  Withdrawal (VIBE L2 → Base)                               │
│  ├─ Standard: ~7 days (challenge period)                   │
│  ├─ Fast: ~1 hour (OP Succinct, coming soon)              │
│  └─ Supported: ETH, USDC                                   │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Commands:                                                 │
│  ├─ vibe bridge deposit 0.1  - Deposit 0.1 ETH            │
│  ├─ vibe bridge withdraw 0.1 - Withdraw 0.1 ETH           │
│  ├─ vibe bridge estimate     - Estimate gas costs         │
│  └─ vibe bridge status       - This screen                │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Bridge UI: https://bridge.vibe.network                    │
│  Explorer:  https://explorer.vibe.network                  │
└────────────────────────────────────────────────────────────┘
`.trim();

  if (txHash) {
    return {
      display: formatted + `\n\n📍 Check your transaction: https://explorer.vibe.network/tx/${txHash}`,
      explorerUrl: `https://explorer.vibe.network/tx/${txHash}`
    };
  }

  return {
    display: formatted,
    bridgeInfo: {
      depositTime: '~1 minute',
      withdrawTime: '~7 days (standard) / ~1 hour (fast)',
      supportedAssets: ['ETH', 'USDC'],
      bridgeUrl: 'https://bridge.vibe.network',
      explorerUrl: 'https://explorer.vibe.network'
    }
  };
}

/**
 * Initiate deposit (Base → VIBE L2)
 */
async function initiateDeposit(handle, amount) {
  if (!amount) {
    return {
      display: 'Amount required. Example: vibe bridge deposit 0.1'
    };
  }

  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    return {
      display: 'Invalid amount. Must be a positive number.'
    };
  }

  return {
    display: `🌉 DEPOSIT ${amount} ETH to VIBE L2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Amount: ${amount} ETH
From: Base
To: VIBE L2
Time: ~1 minute

To complete this deposit:

Option 1: Bridge UI (Recommended)
  Visit https://bridge.vibe.network
  Connect your wallet
  Select "Deposit" and enter ${amount} ETH

Option 2: Direct Contract Call
  Contract: StandardBridge on Base
  Function: depositETH
  Gas Limit: ~100,000

Note: After depositing, your ETH will be available on
VIBE L2 within ~1 minute. You can then mint artifacts
and earn Shipback!`,
    action: 'deposit_guidance',
    amount,
    bridgeUrl: `https://bridge.vibe.network?amount=${amount}&direction=deposit`
  };
}

/**
 * Initiate withdrawal (VIBE L2 → Base)
 */
async function initiateWithdraw(handle, amount) {
  if (!amount) {
    return {
      display: 'Amount required. Example: vibe bridge withdraw 0.1'
    };
  }

  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    return {
      display: 'Invalid amount. Must be a positive number.'
    };
  }

  return {
    display: `🌉 WITHDRAW ${amount} ETH to Base
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Amount: ${amount} ETH
From: VIBE L2
To: Base
Time: ~7 days (standard) or ~1 hour (fast mode)

⚠️ IMPORTANT: Withdrawals have a 7-day challenge period.
This is standard for OP Stack chains (same as Base, Optimism).

Fast withdrawals (~1 hour) will be available with OP Succinct.

To complete this withdrawal:

1. Visit https://bridge.vibe.network
2. Connect your wallet
3. Select "Withdraw" and enter ${amount} ETH
4. Submit the transaction on VIBE L2
5. Wait for challenge period
6. Finalize on Base

Alternative: Claim your Shipback earnings instead!
  → vibe shipback balance`,
    action: 'withdraw_guidance',
    amount,
    standardTime: '7 days',
    fastTime: '~1 hour (coming soon)',
    bridgeUrl: `https://bridge.vibe.network?amount=${amount}&direction=withdraw`
  };
}

/**
 * Estimate gas costs
 */
async function estimateGas(amount) {
  const depositGas = 100000;
  const withdrawGas = 150000;
  const gasPrice = 0.001; // gwei on L2
  const baseGasPrice = 0.5; // gwei on Base

  const depositCostEth = (depositGas * baseGasPrice) / 1e9;
  const withdrawCostL2 = (withdrawGas * gasPrice) / 1e9;
  const withdrawCostBase = (depositGas * baseGasPrice) / 1e9;

  return {
    display: `⛽ BRIDGE GAS ESTIMATES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deposit (Base → VIBE L2):
  Gas: ~${depositGas.toLocaleString()} units
  Cost: ~${depositCostEth.toFixed(6)} ETH
  Note: Paid on Base

Withdrawal (VIBE L2 → Base):
  Initiate (on L2): ~${withdrawCostL2.toFixed(8)} ETH
  Finalize (on Base): ~${withdrawCostBase.toFixed(6)} ETH
  Total: ~${(withdrawCostL2 + withdrawCostBase).toFixed(6)} ETH

On VIBE L2:
  Gas price: ~${gasPrice} gwei (ultra cheap!)
  Mint cost: ~0.0001 ETH

💡 Tip: VIBE L2 has very low gas fees.
   Deposit once, mint many artifacts cheaply!`,
    estimates: {
      deposit: { gas: depositGas, costEth: depositCostEth },
      withdraw: {
        initiateGas: withdrawGas,
        finalizeCostEth: withdrawCostBase,
        totalCostEth: withdrawCostL2 + withdrawCostBase
      },
      l2GasPrice: gasPrice
    }
  };
}

module.exports = { definition, handler };
