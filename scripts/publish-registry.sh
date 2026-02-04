#!/bin/bash
# Publish /vibe to the official MCP Registry
# https://modelcontextprotocol.info/tools/registry/publishing/
#
# Prerequisites:
#   1. Package must be live on npm (npm publish)
#   2. brew install mcp-publisher (or download binary — see below)
#   3. mcp-publisher login github
#
# Install mcp-publisher (pick one):
#   brew install mcp-publisher
#   — or —
#   curl -L "https://github.com/modelcontextprotocol/registry/releases/download/v1.0.0/mcp-publisher_1.0.0_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
#
# Usage: ./scripts/publish-registry.sh

set -e

echo ""
echo "/vibe → MCP Registry Publisher"
echo "================================"
echo ""

# Check mcp-publisher is installed
if ! command -v mcp-publisher &> /dev/null; then
  echo "mcp-publisher not found."
  echo ""
  echo "Install via Homebrew:"
  echo "  brew install mcp-publisher"
  echo ""
  echo "Or download binary:"
  echo "  curl -L \"https://github.com/modelcontextprotocol/registry/releases/download/v1.0.0/mcp-publisher_1.0.0_\$(uname -s | tr '[:upper:]' '[:lower:]')_\$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz\" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/"
  echo ""
  exit 1
fi

# Sync versions first
echo "Syncing versions..."
node scripts/sync-version.js

# Validate server.json
echo ""
echo "Validating server.json..."
mcp-publisher publish --dry-run

echo ""
echo "Dry run passed. Ready to publish?"
echo ""
read -p "Publish to MCP Registry? (y/N) " confirm

if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
  mcp-publisher publish
  echo ""
  echo "Published to MCP Registry!"
  echo "View at: https://registry.modelcontextprotocol.io"
else
  echo "Cancelled."
fi
