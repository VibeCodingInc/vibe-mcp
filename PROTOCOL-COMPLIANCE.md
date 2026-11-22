# MCP Protocol Compliance — slashvibe-mcp

Status of this server against MCP spec revision **2026-07-28**. The protocol
layer is hand-rolled in `index.js` (no SDK), so compliance is ours to maintain;
this file is the ledger. Verified by `tools/_mcp-protocol.test.js`.

## Era served: `initialize` only (stateless code kept, switched off)

The server implements both eras, but as shipped it serves only the legacy,
`initialize` era (`SERVE_STATELESS = false` in `index.js`):

- **Legacy** (2025-11-25 and earlier): `initialize` negotiates — the
  client's version is echoed when known; unknown versions get our latest
  legacy revision. `initialize` always selects this era, even if its params
  carry `_meta`. A request whose `_meta` names a legacy version is served
  under legacy semantics.
- **Modern** (2026-07-28): not served. `server/discover` is answered exactly
  as by a server that does not implement it —
  `{"code": -32601, "message": "Method not found: server/discover"}` — so a
  dual-era client's stdio probe falls back to `initialize` (the 2026-07-28
  stdio binding: fall back on "any other error"; a recognized modern error
  such as -32022 on the probe would mean "do **not** fall back"). Any other
  request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` =
  `2026-07-28` gets `UnsupportedProtocolVersionError` (-32022) with
  `data.supported` = the initialize-era versions, per the versioning rule
  that a server which does not implement the requested version MUST say so
  and list what it supports.

Why: /vibe's Send box is an `elicitation/create` the server sends during
`vibe_send`. Claude Code 2.1.330 shows that box on the `initialize` path. On
the 2026-07-28 path the equivalent is an `input_required` result, and Claude
Code 2.1.330 answered it "accept" about two seconds later without showing
anything to the person (measured 2026-11-21). Claude Code probes
`server/discover` first and uses 2026-07-28 for any server that answers it,
so serving it would make the box decorative. Turning the stateless path back
on is two deliberate changes: `SERVE_STATELESS` in `index.js`, and
`STATELESS_BOX_SHOWN` in `confirm-box.js` before an answer there can count
as the person's Accept. Its tests run through
`test/fixtures/stateless-server.cjs` (not shipped).

Nothing user-visible on Claude Code depends on the stateless era: tools,
instructions, capabilities (including the opt-in `claude/channel`) and
`notifications/tools/list_changed` all work on `initialize`; host
identification comes from `initialize` clientInfo.

## Implemented for 2026-07-28 (behind `SERVE_STATELESS`, off as shipped)

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
- **MRTR** (`input_required` results): implemented only for the Send box,
  behind `SERVE_STATELESS` and `STATELESS_BOX_SHOWN` (both off: Claude Code
  2.1.330 answers it without showing the box). The auth gate answers with an
  inline sign-in flow instead.
- **Per-request log level** (`io.modelcontextprotocol/logLevel`) ignored — we
  never emit `notifications/message`, so nothing to gate yet.
