# Phase 1 — Identity on the hosted MCP endpoint (REV 3: **stop being an authorization server**)

**Status:** DESIGN ONLY. Three adversarial rounds (codex xhigh, read-only). REV 1 and
REV 2 both returned "do not build as written." **REV 3 is a structural pivot, not
another patch round** — see §0 for why.
**Context:** Phase 0 is live: `POST /api/mcp` at `https://www.slashvibe.dev/api/mcp`,
read-only, board validated in claude.ai. Scope frame: `REMOTE-VARIANT-SCOPE.md`.

---

## 0. Why REV 3 changes shape instead of patching again

Finding counts across rounds: **REV 1 → 8 findings. REV 2 → 5 still open + 4 new = 9.**
That is *not* converging. Compare the loop-lane hardening, which went 7→5→3→2→clean:
there, patching worked because the defects were local. Here it isn't working, which
means the problem is architectural.

Look at *which* items closed versus stayed open:

| Sound after 3 rounds | Still open after 3 rounds |
|---|---|
| §2.0 `/api/mcp` accepts one credential type | `/authorize` legacy-session laundering |
| §2.1 narrow MCP audience + token type | state/upstream-state/browser-binding conflation |
| 059 refresh rotation (fails closed) | refresh not tied to a durable revocable grant |
| request-driven presence *semantics* | consent CSRF / clickjacking, CIMD SSRF, client impersonation, grant representation, device identity |

**Every closed item is where we behave as a RESOURCE SERVER. Every open item is where we
behave as an AUTHORIZATION SERVER.** The conclusion is not "try harder at the authorize
flow." It's: **don't own the authorize flow.**

MCP 2026-07-28 explicitly supports this — `/.well-known/oauth-protected-resource` points
at *an* authorization server, which need not be us. So:

> **Phase 1 decision: /vibe is a RESOURCE SERVER only. The authorization server is
> delegated to an audited external AS.** We keep the two things codex has now blessed
> twice (single credential type, narrow audience/type verification) plus the Actor layer
> for principal mapping — and we delete our authorize endpoint, our consent screen, our
> client registration, our grant store, and our device identity from the design.

Findings this deletes outright (they stop being our surface): **1, 3, 4**, plus the new
consent-CSRF/clickjacking, CIMD-SSRF/client-impersonation, and grant-representation
risks. Findings that remain ours regardless: **5** (internal privileged effects) and
**6** (handle adoption inside migration 059), and the per-principal half of **8**.

### AS options (decide before REV 4)

1. **Managed AS** (WorkOS / Stytch / Auth0-class): standards-complete OAuth 2.1 with
   PKCE, DCR/CIMD, consent, grant revocation, audited. Cost: a vendor in the identity
   path, and GitHub becomes an upstream connection there.
2. **GitHub App-based delegation**: closest to today's login, but GitHub is not an OAuth
   *AS for our resource* — we'd be re-implementing the AS around it. **This is what REV
   1–2 tried and it is what keeps failing.** Rejected unless someone can show otherwise.
3. **Self-host a real AS implementation** (a maintained OAuth 2.1 server library) rather
   than hand-rolling endpoints: keeps data in-house, still deletes the hand-rolled
   authorize/consent/registration logic that every finding targets.

Recommendation: **(1) for Phase 1**, revisit (3) later if vendor dependency becomes a
problem. Rationale: identity is the one place where "we hand-rolled it" is a liability,
and three rounds of attack have demonstrated that empirically on our own design.

---

## 1. What Phase 1 must still deliver (unchanged)

1. Connect the URL in claude.ai, sign in, act as the **existing /vibe handle**.
2. Every write attributed to the token's principal; **the body never names the actor**.
3. `vibe_who` stays public and unauthenticated (§5).
4. Leaked tokens bounded: short access life, rotating refresh, revocation.
5. Browser presence honest (`via: web`, request-driven).
6. stdio and hosted coexist for one principal.

---

## 2. Our surface as a resource server (all that we build)

### 2.1 Verification — the blessed core, keep exactly as specified
- `/api/mcp` accepts **exactly one** credential type: an access token from the delegated
  AS, audience `https://www.slashvibe.dev/api/mcp` (RFC 8707), of the expected token
  type. **A legacy `SESSION_SECRET` JWT is 401 in every mode, forever.**
- `shadow` mode = **log discrepancies only**. There is no authorization fallback path,
  and no second verifier in the request path, in any mode.
- Audience + issuer are **single exported constants** shared by every call site.
- Rejection returns `WWW-Authenticate` with `resource_metadata` pointing at the AS.

### 2.2 `/.well-known/oauth-protected-resource`
Static metadata naming the delegated AS, the resource identifier, and supported scopes.
This is the *only* OAuth-shaped endpoint we own.

### 2.3 One canonical per-tool authorization boundary — *finding 5, still ours*
Codex's surviving attack: **internal privileged effects can bypass the outer registry** —
a tool whose handler reaches another tool's logic (or a store method with side effects)
never re-checks scope. Design change:

- The registry stays the single pre-dispatch gate (`vibe_who: { scope: null }` explicit;
  unknown tool → `-32601`, never default-allow).
- **Additionally, authorization moves to the effect, not just the entry point**: every
  write-capable store function takes an explicit authenticated principal + scope
  assertion parameter, and refuses a null/unasserted caller. A tool cannot obtain a
  privileged effect merely by being reached.
- **No tool handler may call another tool's handler.** Shared logic is extracted into
  non-privileged helpers that require the assertion above.

### 2.4 Identity binding — *finding 6, needs a MIGRATION, not prose*
Verified: `migrations/059_actor_stage2a_tokens.sql:109` — when no `external_identities`
row matches the provider subject, the function **adopts the principal whose
`actor_handles.handle` equals the supplied handle.** A new provider subject arriving with
an existing handle therefore takes over that principal. Dormant today
(`ACTOR_AUTH_MODE=off`), and this is the layer Phase 1 would wake.

Required: **a migration that removes the handle-adoption fallback** from that function.
Subject not found ⇒ create a new principal, or fail — never adopt by handle. Account
recovery/handle transfer becomes an explicit human-reviewed flow, out of Phase 1 scope.
No auth path may look up a principal by handle or username; the handle is derived output.

### 2.5 Per-principal limits — *finding 8, the half that stays ours*
Authenticated calls are budgeted **per principal and per token/session identifier issued
by the AS** — never per client-supplied "device" (codex: forgeable; and with a delegated
AS we stop inventing device identity at all). Unauthenticated `vibe_who` keeps its IP
budget.

### 2.6 Presence — semantics blessed, **storage model is the open question**
Request-driven (`lastWrite` bumped by authenticated calls, `via: web`) is sound. Codex
flags the **shared storage model**: hosted and stdio both writing presence for one
principal, last-writer-wins, can erase honest state. REV 4 must specify presence as
**per-runtime rows aggregated at read time**, not one mutable row per handle.

---

## 3. Review ledger

| # | Finding | REV 2 | REV 3 disposition |
|---|---|---|---|
| 1 | Legacy-credential downgrade | relocated to `/authorize` | **Deleted with the AS** (§0) |
| 2 | Broad `aud=vibe-api` | closed | closed — keep as specified |
| 3 | State/binding conflation | open | **Deleted with the AS** |
| 4 | Refresh not tied to a revocable grant | open | **Deleted with the AS** (AS owns grants) |
| 5 | Internal effects bypass registry | open | **Ours** → §2.3 effect-level assertions |
| 6 | Handle adoption (`059:109`, verified) | open | **Ours** → §2.4 migration required |
| 7 | Refresh rotation | closed | closed — do not re-engineer |
| 8 | IP limits + forgeable device id | open | per-principal → §2.5; device id deleted with the AS |
| new | consent CSRF, CIMD SSRF, grant representation, scope vocabulary | — | **Deleted with the AS**; scope vocabulary must match the AS's |
| new | presence shared-storage model | — | **Ours** → §2.6, specify in REV 4 |

---

## 4. REV 4 must answer

1. **Which AS** (§0 options) — this is a product/ops decision, not a code one.
2. **Per-runtime presence storage** replacing last-writer-wins (§2.6).
3. **Effect-level authorization**: the exact assertion signature every write-capable
   store function takes, and how it's enforced repo-wide (a lint rule? a wrapper?).
4. **The 059 migration** removing handle adoption, with a dirty-data plan (are there
   existing rows whose principal was adopted by handle?).
5. Scope vocabulary reconciled with the chosen AS's model.

---

## 5. The invariant that must not be broken

**Presence GET stays public.** The hosted board (`vibe_who`) and stdio's pre-auth
`vibe_who` serve the room without a token by design. Gate presence **writes** behind auth
(that is the impersonation fix); gating **reads** breaks the surface validated in
claude.ai. `/api/mcp` stays exempt from any blanket auth-middleware sweep.

## 6. Non-goals (Phase 1)

No admin tools or session-coupled tools (`play`/`weave`/`fable`) on hosted; no push
delivery; no enterprise IdP provisioning; **no change to stdio auth**; **and now: no
hand-rolled authorization server.**
