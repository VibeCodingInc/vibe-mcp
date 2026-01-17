/**
 * vibe_mint — Mint a /vibe moment as an NFT
 *
 * Supports multiple chains:
 * - vibe-l2 (default) — VIBE L2 with Shipback (80% gas fees to creator)
 * - base — Base mainnet
 * - base-sepolia — Base testnet
 * - ethereum — Ethereum mainnet
 *
 * Flow:
 * 1. Upload metadata to IPFS (Pinata)
 * 2. Call VibeArtifacts.mintArtifact() with session provenance
 * 3. Return tx hash + token ID + marketplace links
 */

// Lazy-load ethers to avoid startup crash if not installed
let ethers = null;
function getEthers() {
  if (!ethers) {
    try {
      ethers = require('ethers');
    } catch (e) {
      throw new Error('ethers package not installed. Run: npm install ethers');
    }
  }
  return ethers;
}

// Polyfill fetch for Node <18
const fetch = globalThis.fetch || require('node-fetch');

const config = require('../config');

// Chain configurations
// Env var format: VIBE_ARTIFACTS_MAINNET / VIBE_ARTIFACTS_TESTNET (matches deploy script)
const CHAINS = {
  'vibe-l2': {
    name: 'VIBE L2',
    chainId: 84532000,  // Mainnet
    rpcUrl: process.env.VIBE_L2_RPC || 'https://rpc.vibe.network',
    contractAddress: process.env.VIBE_ARTIFACTS_MAINNET,
    explorerUrl: 'https://explorer.vibe.network',
    marketplaceUrl: 'https://slashvibe.dev/a',
    shipbackEnabled: true,
    recommended: true
  },
  'vibe-l2-testnet': {
    name: 'VIBE L2 Testnet',
    chainId: 84532001,  // Testnet
    rpcUrl: process.env.VIBE_L2_TESTNET_RPC || 'https://rpc-testnet.vibe.network',
    contractAddress: process.env.VIBE_ARTIFACTS_TESTNET,
    explorerUrl: 'https://explorer-testnet.vibe.network',
    marketplaceUrl: 'https://slashvibe.dev/a',
    shipbackEnabled: true
  },
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    contractAddress: process.env.VIBE_ARTIFACTS_BASE_SEPOLIA,
    explorerUrl: 'https://sepolia.basescan.org',
    marketplaceUrl: 'https://testnets.opensea.io/assets/base-sepolia',
    shipbackEnabled: false
  },
  'base': {
    name: 'Base',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    contractAddress: process.env.VIBE_ARTIFACTS_BASE,
    explorerUrl: 'https://basescan.org',
    marketplaceUrl: 'https://opensea.io/assets/base',
    shipbackEnabled: false
  },
  'ethereum': {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
    contractAddress: process.env.VIBE_ARTIFACTS_ADDRESS,
    explorerUrl: 'https://etherscan.io',
    marketplaceUrl: 'https://opensea.io/assets/ethereum',
    shipbackEnabled: false
  }
};

// Get default chain (prefer VIBE L2 if configured)
function getDefaultChain() {
  if (CHAINS['vibe-l2'].contractAddress) return 'vibe-l2';
  if (CHAINS['vibe-l2-testnet'].contractAddress) return 'vibe-l2-testnet';
  if (CHAINS['base-sepolia'].contractAddress) return 'base-sepolia';
  if (CHAINS['base'].contractAddress) return 'base';
  return 'ethereum';
}

// Contract ABI (extended for session provenance)
const VIBE_ARTIFACTS_ABI = [
  // Legacy simple mint
  'function mint(address to, string memory uri) public returns (uint256)',
  // New mint with provenance
  'function mintArtifact(address to, string uri, string sessionId, string creatorHandle, string artifactType, bytes32 sessionHash, address royaltyRecipient, uint96 royaltyBps) returns (uint256)',
  'function totalSupply() public view returns (uint256)',
  'event ArtifactMinted(uint256 indexed tokenId, address indexed creator, string sessionId, string artifactType, bytes32 sessionHash)'
];

const PINATA_JWT = process.env.PINATA_JWT || null;
const MINTER_PRIVATE_KEY = process.env.VIBE_MINTER_PRIVATE_KEY || null;

const definition = {
  name: 'vibe_mint',
  description: 'Mint a /vibe artifact as an NFT. Default: VIBE L2 (80% Shipback). Also supports Base, Ethereum.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the artifact'
      },
      description: {
        type: 'string',
        description: 'Description of what happened'
      },
      chain: {
        type: 'string',
        description: 'Chain to mint on: vibe-l2, base, base-sepolia, ethereum (default: vibe-l2)'
      },
      session_id: {
        type: 'string',
        description: 'Session ID for provenance (ses_xxx)'
      },
      attributes: {
        type: 'object',
        description: 'Optional attributes',
        additionalProperties: true
      },
      image_url: {
        type: 'string',
        description: 'Optional image URL'
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview without minting'
      }
    },
    required: ['title', 'description']
  }
};

async function uploadToIPFS(metadata) {
  if (!PINATA_JWT) {
    throw new Error('PINATA_JWT not configured');
  }

  const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PINATA_JWT}`
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: {
        name: `vibe-artifact-${Date.now()}`
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Pinata upload failed: ${response.statusText}`);
  }

  const result = await response.json();
  return `ipfs://${result.IpfsHash}`;
}

async function mintOnchain(uri, chain, creatorHandle, sessionId) {
  if (!chain.contractAddress) {
    throw new Error(`Contract not configured for ${chain.name}`);
  }
  if (!MINTER_PRIVATE_KEY) {
    throw new Error('VIBE_MINTER_PRIVATE_KEY not configured');
  }

  const ethers = getEthers();
  const crypto = require('crypto');

  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  const wallet = new ethers.Wallet(MINTER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(chain.contractAddress, VIBE_ARTIFACTS_ABI, wallet);

  // Compute session hash for provenance
  const sessionData = JSON.stringify({ sessionId, creatorHandle, timestamp: Date.now() });
  const sessionHash = '0x' + crypto.createHash('sha256').update(sessionData).digest('hex');

  let tx;
  try {
    // Try new mintArtifact with provenance
    tx = await contract.mintArtifact(
      wallet.address,      // to
      uri,                 // metadata URI
      sessionId,           // session ID
      creatorHandle,       // creator handle
      'session_artifact',  // artifact type
      sessionHash,         // session hash
      wallet.address,      // royalty recipient
      1000                 // 10% royalty (1000 bps)
    );
  } catch (e) {
    // Fallback to legacy mint if new function not available
    console.log('[mint] Falling back to legacy mint:', e.message);
    tx = await contract.mint(wallet.address, uri);
  }

  const receipt = await tx.wait();

  // Parse the event to get tokenId
  const event = receipt.logs.find(log => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === 'ArtifactMinted';
    } catch {
      return false;
    }
  });

  let tokenId = null;
  if (event) {
    const parsed = contract.interface.parseLog(event);
    tokenId = parsed.args.tokenId.toString();
  }

  return {
    txHash: receipt.hash,
    tokenId,
    contractAddress: chain.contractAddress
  };
}

async function handler(args) {
  const {
    title,
    description,
    chain: chainArg,
    session_id,
    attributes = {},
    image_url,
    dry_run = false
  } = args;

  // Get handle from config
  const handle = config.isInitialized() ? config.getHandle() : 'anonymous';

  // Determine chain
  const chainName = chainArg || getDefaultChain();
  const chain = CHAINS[chainName];

  if (!chain) {
    return {
      display: `Unknown chain: ${chainArg}\n\nAvailable chains:\n` +
        Object.entries(CHAINS).map(([k, v]) =>
          `• ${k} - ${v.name}${v.shipbackEnabled ? ' (80% Shipback)' : ''}${v.recommended ? ' ✨' : ''}`
        ).join('\n')
    };
  }

  // Build metadata with session provenance
  const sessionId = session_id || `ses_${Date.now()}`;
  const metadata = {
    name: title,
    description,
    attributes: [
      { trait_type: 'Source', value: '/vibe MCP' },
      { trait_type: 'Minted Via', value: 'Claude Code' },
      { trait_type: 'Chain', value: chain.name },
      { trait_type: 'Creator', value: `@${handle}` },
      { trait_type: 'Session', value: sessionId },
      { trait_type: 'Date', value: new Date().toISOString().split('T')[0] },
      ...Object.entries(attributes).map(([key, value]) => ({
        trait_type: key,
        value: String(value)
      }))
    ],
    external_url: `https://slashvibe.dev/a/${sessionId}`,
    // Session provenance
    provenance: {
      sessionId,
      creatorHandle: handle,
      mintedAt: new Date().toISOString(),
      chain: chainName,
      shipbackEnabled: chain.shipbackEnabled
    }
  };

  if (image_url) {
    metadata.image = image_url;
  }

  // Dry run - show metadata and chain info
  if (dry_run) {
    let display = `## Dry Run - Metadata Preview\n\n`;
    display += `**Chain:** ${chain.name}${chain.shipbackEnabled ? ' (80% Shipback enabled!)' : ''}\n\n`;
    display += '```json\n' + JSON.stringify(metadata, null, 2) + '\n```\n\n';
    display += `Ready to mint. Run without \`dry_run\` to mint onchain.`;
    return { display };
  }

  // Check configuration
  if (!chain.contractAddress) {
    let display = `## Configuration Required\n\n`;
    display += `Chain **${chain.name}** is not configured.\n\n`;

    if (chain.shipbackEnabled) {
      display += `To use VIBE L2 (recommended - 80% Shipback):\n`;
      display += `1. Sign up at https://conduit.xyz\n`;
      display += `2. Deploy contracts: \`node scripts/deploy-vibe-l2.js\`\n`;
      display += `3. Set env var: \`VIBE_ARTIFACTS_TESTNET=0x...\`\n\n`;
    }

    display += `Available configured chains:\n`;
    Object.entries(CHAINS).forEach(([k, v]) => {
      if (v.contractAddress) {
        display += `• ${k} - ${v.name}\n`;
      }
    });

    if (!Object.values(CHAINS).some(c => c.contractAddress)) {
      display += `\nNo chains configured. Set environment variables:\n`;
      display += `• VIBE_ARTIFACTS_TESTNET (recommended)\n`;
      display += `• VIBE_ARTIFACTS_BASE_SEPOLIA\n`;
      display += `• VIBE_MINTER_PRIVATE_KEY\n`;
      display += `• PINATA_JWT\n`;
    }

    return { display };
  }

  try {
    // 1. Upload to IPFS
    const ipfsUri = await uploadToIPFS(metadata);

    // 2. Mint onchain
    const { txHash, tokenId } = await mintOnchain(ipfsUri, chain, handle, sessionId);

    // 3. Build result
    const explorerUrl = `${chain.explorerUrl}/tx/${txHash}`;
    const marketplaceUrl = tokenId
      ? `${chain.marketplaceUrl}/${chain.contractAddress}/${tokenId}`
      : null;

    let display = `## 🎨 VIBE #${tokenId || '?'} Minted on ${chain.name}\n\n`;
    display += `**${title}**\n\n`;
    display += `• IPFS: \`${ipfsUri}\`\n`;
    display += `• Tx: [${txHash.slice(0, 10)}...](${explorerUrl})\n`;
    display += `• Creator: @${handle}\n`;
    display += `• Session: ${sessionId}\n`;

    if (marketplaceUrl) {
      display += `• View: [Marketplace](${marketplaceUrl})\n`;
    }

    if (chain.shipbackEnabled) {
      display += `\n💰 **Shipback enabled!** You'll earn 80% of all gas fees from interactions.\n`;
      display += `Check earnings: \`vibe l2 shipback\``;
    }

    display += `\n\n_Onchain. Forever._`;

    return { display };

  } catch (err) {
    return {
      display: `## Mint Failed\n\n${err.message}\n\n` +
        `Chain: ${chain.name}\n` +
        `Check configuration and try again.`
    };
  }
}

module.exports = { definition, handler };
