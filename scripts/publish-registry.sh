#!/bin/bash
# Publish /vibe to the official MCP Registry
# https://modelcontextprotocol.info/tools/registry/publishing/
#
# Prerequisites:
#   1. npm publish (package must be live on npm)
#   2. npm install -g @modelcontextprotocol/publisher
#   3. mcp-publisher login github
#
# Usage: ./scripts/publish-registry.sh

set -e

echo ""
echo "/vibe → MCP Registry Publisher"
echo "================================"
echo ""

# Check mcp-publisher is installed
if ! command -v mcp-publisher &> /dev/null; then
  echo "mcp-publisher not found. Installing..."
  npm install -g @modelcontextprotocol/publisher
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
