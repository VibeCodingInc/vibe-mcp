# Remote slashvibe-mcp — Scope (2026-07-28)

**Why:** MCP 2026-07-28's stateless core + Claude's live support for remote
connectors (claude.ai, Desktop) means /vibe presence can exist in **every
Claude surface** with zero install: paste a URL, OAuth, you're on the board.
The stdio package stays the flagship terminal experience; the hosted variant
is reach. Announcement: https://claude.com/blog/bringing-mcp-2026-07-28-to-claude

## The load-bearing decision: new thin endpoint, not a port

Audit findings (2026-07-28, this repo):

- **31 modules** in the stdio server read local-disk identity
  (`config.getHandle` / `apiHeaders` / `authStore`) — a per-request-context
  refactor of the tool layer would touch all of them.
- The stdio server's process-lifetime machinery — presence heartbeat (30s
  interval), guest-message polling, `injectedDmIds` once-only dedupe,
  notification debounce — **all assumes a long-lived process** and dies on
  serverless.
- But the tools are mostly **markdown formatters over the platform HTTP API**
  (`store/api.js` → `www.slashvibe.dev/api`), and that API already runs on
  Vercel in this repo (`api/`).

Therefore: the hosted variant is a **new `api/mcp.js` endpoint in the existing
Vercel app** speaking modern-era MCP only (2026-07-28 stateless — a perfect
fit for serverless, no session plumbing at all). It calls the same internal
API/KV functions the REST endpoints use. It does NOT import the stdio tool
handlers. Shared between the two servers: tool **schemas** (extract to a
shared module or duplicate deliberately), and `resources/presence-board.js`
(the MCP App renders identically over both transports).

Explicitly dropped in hosted (terminal-only concepts): OSC escape sequences,
the ambient footer, guest-message/DM context injection, `vibe_weave`/
`vibe_fable`/`vibe_play` (session-coupled), admin tools, auto-update.

## Phases

**Phase 0 — spike (≈1 day).** `POST /api/mcp`: `server/discover`,
`tools/list` (vibe_who only), `tools/call`, `resources/read` for the presence
board. Auth: existing v2 bearer token pasted as header (no OAuth yet).
Accept: presence board renders in claude.ai connected to the URL from a
personal account. This validates the whole thesis before the auth build.

**Phase 1 — OAuth (the meaty half, ≈2–4 days).** Claude remote connectors
require spec auth: protected-resource metadata (`/.well-known/
oauth-protected-resource`), authorization-server metadata, authorization-code
+ PKCE, resource indicators. Bridge to what exists: the GitHub OAuth flow
already issues our tokens (`vibe_init` browser flow) — wrap it as the
authorization server; issued token = existing v2 token. Honor 2026-07-28
notes: Client ID Metadata Documents (DCR is deprecated), `iss` validation.

**Phase 2 — social core surface (≈2 days).** `vibe_dm`, `vibe_inbox`,
`vibe_reply`, `vibe_status`, `vibe_ship`, `vibe_feed` + `vibe_who`.
Presence becomes **request-driven**: every authed tools/call bumps lastSeen
(no heartbeat process). "Online from claude.ai" is a presence texture win —
surface it (`via: web` on the board).

**Phase 3 — distribution.** Submit to Claude's connectors directory (950+
servers; the discovery channel in front of exactly our users). Prereqs:
0.7.1+ published on npm (stdio listing) and the hosted URL stable. The
observability dashboard for published connectors then answers the fleet-wide
invocation-count question (open item #4 from the 0.7.0 audit) for free.

## Decisions to make (flagging now, not blocking Phase 0)

- **Identity convergence:** hosted tokens are per-handle bearer creds — this
  is the Golden Thread / Actor-token direction; design the token→principal
  mapping so it converges with actorization rather than forking a third
  identity scheme.
- **DM delivery:** no push channel statelessly — hosted inbox is pull-only.
  Acceptable (claude.ai users check in); revisit with `subscriptions/listen`
  if Claude's client supports it for remote connectors.
- **Rate limiting / abuse:** the REST API's existing limits apply since we
  call the same internals; confirm per-token limits before directory listing.
- **Stan's client:** hosted variant changes nothing Stan consumes (additive
  endpoint), but flag before directory submission — the listing is public.

## Non-goals

- Porting play/weave/fable to hosted (session-coupled by design).
- Tasks extension (queued for the doorbell/summon arc, see
  PROTOCOL-COMPLIANCE.md).
- MCP tunnels (research preview; watch for the local-bot-port pattern).
