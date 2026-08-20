# MCP Protocol Compliance — slashvibe-mcp

Status of this server against MCP spec revision **2026-07-28**. The protocol
layer is hand-rolled in `index.js` (no SDK), so compliance is ours to maintain;
this file is the ledger. Verified by `tools/_mcp-protocol.test.js`.

## Dual-era design

The server serves both eras from one process, per the spec's compatibility
matrix:

- **Modern** (2026-07-28): a request carrying
  `_meta["io.modelcontextprotocol/protocolVersion"]` is served statelessly —
  `resultType` on every result, `serverInfo` echoed in result `_meta`,
  `UnsupportedProtocolVersionError` (-32022) for versions we don't speak.
- **Legacy** (2025-11-25 and earlier): `initialize` still works and now
  negotiates properly — the client's version is echoed when known instead of
  pinning 2024-11-05; unknown versions get our latest legacy revision.

Claude Code today opens with `initialize` (legacy era); nothing breaks, and
modern clients get modern semantics the day they arrive.

## Implemented (2026-07-28)

| Requirement | Where |
|---|---|
| `server/discover` (MUST) — versions, capabilities, identity, doubles as stdio probe | `index.js` dispatch |
| Per-request `_meta` version gate + `-32022` error | `handleRequest` |
| `resultType: "complete"` + serverInfo `_meta` on modern results | `handleRequest` decoration |
| `CacheableResult` (`ttlMs`/`cacheScope`) on tools/list, resources/list, resources/read | dispatch cases |
| Deterministic tools/list order (SHOULD) | registration-object order, stable by construction |
| Resource-not-found as `-32602` (was `-32002`) | resources/read |
| `extensions` capability field — declares `io.modelcontextprotocol/ui` (MCP Apps) | `SERVER_CAPABILITIES` |
| Never implemented the now-deprecated Roots/Sampling/Logging — nothing to migrate | — |

## MCP Apps

`vibe_who` declares `_meta.ui.resourceUri: ui://vibe/presence-board`
(`resources/presence-board.js` — self-contained HTML, empty CSP, ~40-line
postMessage bridge). Hosts with the `io.modelcontextprotocol/ui` extension
render the live presence board in-conversation; text-only hosts see the
markdown exactly as before. Data rides `structuredContent` on `vibe_who`
results — server-side presence controls (Buddy 0.5.15 status/detail/invisible)
apply automatically.

## Known gaps (deliberate, revisit when a modern client ships)

- **`subscriptions/listen` not implemented** — we still push
  `notifications/tools/list_changed` unsolicited (legacy style). Correct for
  legacy clients; out-of-contract-but-ignored for modern ones. Implement when
  a real modern client appears.
- **Tasks extension** (`io.modelcontextprotocol/tasks`) not declared — a
  candidate transport for summon/call workflows; decide with the doorbell arc.
- **MRTR** (`input_required` results) unused — our auth gate answers with an
  inline sign-in flow instead; consider migrating the gate to MRTR later.
- **Per-request log level** (`io.modelcontextprotocol/logLevel`) ignored — we
  never emit `notifications/message`, so nothing to gate yet.
