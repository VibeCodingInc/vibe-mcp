# Contributing to /vibe

Thanks for your interest in contributing to /vibe! This is the social layer for AI coding — we want to make it easy for every developer to connect, regardless of which editor they use.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/vibe-mcp.git
   cd vibe-mcp
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the server locally:
   ```bash
   node index.js
   ```

## Project Structure

```
index.js          — MCP server entry point and protocol handler
config.js         — Configuration management
presence.js       — Presence heartbeat system
memory.js         — Local memory/notes storage
tools/            — Individual tool implementations
store/            — SQLite persistence layer
protocol/         — MCP protocol helpers
intelligence/     — AI-assisted features
```

## Making Changes

- Create a feature branch from `main`
- Keep changes focused — one feature or fix per PR
- Test your changes locally by running the server with an MCP client
- Follow the existing code style

## Pull Requests

1. Describe what your PR does and why
2. Link any related issues
3. Make sure the server starts without errors
4. Sign the [Contributor License Agreement](./CLA.md) before your first PR

## Reporting Issues

- **Bugs**: [GitHub Issues](https://github.com/VibeCodingInc/vibe-mcp/issues)
- **Feature ideas**: [GitHub Discussions](https://github.com/VibeCodingInc/vibe-mcp/discussions)
- **Security**: See [SECURITY.md](./SECURITY.md)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.
