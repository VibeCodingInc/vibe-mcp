# PLG code briefing — `slashvibe-mcp` (this tree)

**Audience:** product-led growth and marketing. This is research, not a product decision.

**Rule:** claim only what this repository’s shipped code does. Hunches are labeled. Public docs at [docs.slashvibe.dev](https://docs.slashvibe.dev) are compared at the end; they are not the source of truth for this briefing.

**Do not treat this file as user-facing copy.** It exists so marketers can answer “is that real?” with file citations.

Checked against:

| Source | What it said on 2026-08-21 |
|---|---|
| This tree (`main` @ `038542b`) | `package.json` / `version.json` / `server.json` = **0.8.17** (updated 2026-08-19) |
| npm `slashvibe-mcp@latest` | **0.8.17**, published 2026-08-20T19:37:30Z, `gitHead` `038542bd…` (matches this commit) |
| GitHub repo description | “Open source MCP server for /vibe - Social layer for Claude Code. DMs, presence, and connection between AI developers.” |
| This tree | **no** string `0.8.16` remains |
| docs.slashvibe.dev/contributing | still names **`slashvibe-mcp@0.8.16`** as the version whose repo links pointed at the private platform repo |

---

## 1. Exact install / first-message loop

What actually happens when someone runs `npx slashvibe-mcp` from a TTY:

```
npx slashvibe-mcp
        │
        ▼
cli.js  ── stdin is a TTY? ──yes──► already signed in with a usable token?
        │                              │
        │                              ├─ never signed in, or token dead → setup.js
        │                              └─ usable token → print “configured”, exit
        │
        └── stdin is a pipe (MCP host) ──► index.js MCP server
```

`cli.js` routes `hook` to the SessionStart installer, `setup` to the wizard, a TTY with no/dead credential into setup, a TTY with a usable credential to a status line, and a piped stdin into the MCP server.

### Setup wizard (`setup.js`)

1. **Detect hosts that already exist on this machine**
   - Claude Code: `~/.claude.json` or a Claude desktop config path
   - Codex: `$CODEX_HOME` or `~/.codex`
   - Cursor: `~/.cursor`
   - If **none** exist, it **creates** `~/.claude.json` so /vibe is wired when Claude Code is installed later. It does **not** invent Cursor/Codex configs.

2. **Write an MCP entry named `vibe`** (skip if already present — it does **not** rewrite a pinned/stale entry):
   ```json
   { "command": "npx", "args": ["-y", "slashvibe-mcp@latest"],
     "env": { "VIBE_API_URL": "https://www.slashvibe.dev" } }
   ```
   Codex gets the same entry as a TOML append.

3. **Health check** `GET https://www.slashvibe.dev/api/health`. Only an explicit unhealthy/down status, or an unreachable host, blocks. `degraded` proceeds.

4. **GitHub OAuth:** bind localhost callback (`127.0.0.1:9876`), open `https://www.slashvibe.dev/login`, wait up to **5 minutes**. GitHub username becomes the handle. Token written to `~/.vibe/config.json` (mode `0600`, dir `0700`). Optional actor-session bundle is installed if the callback includes one.

5. Print “Restart your coding agent”, “Send a real message…”, and (Claude Code) `npx slashvibe-mcp hook install`.

### After setup

| Step | What the code actually requires |
|---|---|
| Restart the coding agent | Setup only **writes config**. The host loads a new MCP server on start (`README.md` and `cli.js`). Until restart, there are no vibe tools in the session. |
| `vibe init` | Needed if they were **not** signed in during setup, or the saved token is dead. If already signed in, `vibe_init` short-circuits: “Already signed in as @handle”. |
| `vibe inbox` | The invited-user path. README is accurate: after restart, unread threads (including a welcome DM the server may have created) are listed. Opening a thread **writes read state**. |

### In-session first message

- Unauthenticated tool calls to `dm` / `inbox` / `status` **auto-run `vibe_init`** instead of failing (`index.js` auth gate).
- Pre-auth surface (until a credential exists): `start`, `init`, `token`, `who`, `dm`, `inbox`, `status`, `help`. Only `start`/`init`/`token`/`who`/`help` actually work without auth; the others trigger sign-in.
- A usable token on disk is **not** the same as a server-verified session. `autoPresence` will not print `🟢 Auto-connected` until `POST /api/auth/verify` returns `valid`. Unreachable ≠ invalid (no green dot either).

### Honest caveats on the install loop

- `npx slashvibe-mcp` from a TTY that is **already signed in** does **not** start the MCP server; it prints “restart your coding agent”.
- An **existing** `mcpServers.vibe` entry is left alone (`status: 'exists'`). A pinned old version is not upgraded by re-running setup. Public docs already warn about this; this tree matches that behavior.
- `vibe_start`’s schema still says “use your X/Twitter handle”. The live OAuth path uses **GitHub**. Treat the X/Twitter string as stale copy inside the tool, not a second identity provider.

---

## 2. The default 10 tools — code vs README

Registration is enforced by `test/pack-artifact.test.mjs`. Default kernel (always registered):

`vibe_start`, `vibe_init`, `vibe_token`, `vibe_who`, `vibe_status`, `vibe_dm`, `vibe_inbox`, `vibe_reply`, `vibe_help`, `vibe_bye`

`VIBE_EXTRAS=1` adds 10 more (20 total): `intro`, `weave`, `fable`, `email`, `ship`, `feed`, `play`, `game`, `poem`, `corpse`. `VIBE_ADMIN=true` adds `admin_inbox`, `test`, `doctor`, `update`, `patterns`.

README’s one-liners vs what the handler actually does:

| Tool | README says | Code actually does | Drift |
|---|---|---|---|
| **who** | “who’s here now (🟢), who’s idle, which agents are around” | GET presence; **🟢 only if `status==='active'` AND `lastSeen` ≤ 10 minutes** (`isHereNow`). Everyone else is **💤 Away** (custom away message or “auto-away”). Agents get 🤖 and optional `(op: @handle)`. Caps 5 green rows. Signed-out is **not** “empty room”. | README says “idle”; the board glyph is **💤 away**, not ○ idle. `getHeat()` can print the **word** `idle` after 10 minutes, but those rows already sit under Away. |
| **dm** | “messages that survive restarts on both sides” | POST `/api/v2/messages` (OAuth) with a one-time `idempotency_key`; refuses >2000 chars; shows a **sender receipt** (`id · N chars stored · server time`). Does **not** attach repo/session context unless the caller passes `payload` / `artifact_slug` / tip. If recipient is not `isHereNow`, adds “away — it’ll be waiting on their next turn.” | “Survive restarts” is true of the **stored row** (server Postgres via this client). It is **not** a guarantee the other person’s agent will surface it. See §4. |
| **inbox** | (bundled with dm/reply) | List unread threads, or open a named handle. **Opening a thread PATCHes read cursor.** One unread sender auto-opens and marks read. Empty inbox does **not** recommend strangers unless `VIBE_EXTRAS=1`. Guest-session messages are a separate poll. | README does not mention that listing vs opening have different read-state side effects. |
| **reply** | (bundled) | Sends to most-recent unread (or `to:`). Same 2000-char refuse + receipt as dm. Then best-effort `markThreadRead`. | Same delivery limits as dm. |
| **status** | “what you’re working on, in words (`shipping`, `debugging`)” | Closed mood vocab (`shipping`, `thinking`, `afk`, `debugging`, `pairing`, `deep`, `celebrating`, `struggling`, `away`, `back`, `clear`) stored as **emoji on the heartbeat**, plus notification **pace** (`slower`/`quiet`/`normal`) and local guided/freeform. | README’s examples are real moods. The stored form is emoji (`🔥`, `🐛`, …), which `who` then maps **back** to words. Not a free-text “what I’m building” field — that is `one_liner` / heartbeat `note`. |
| **help** | “plus setup plumbing” | Lists **registered** tools only (pack test guards `vibe X` drift). With extras off, culture tools are named **without** the `vibe X` form. | Accurate. |
| **start** | README table: `vibe` → “inbox + who’s online” | If no OAuth → `vibe_init`. Else: welcome card, up to 5 others, unread previews, optional weave moment, guest messages. **Does not apply `isHereNow`** — heading is `**🟢 Online now:**` for everyone `getActiveUsers()` returned. Rotating tips advertise **unregistered** commands (`vibe stuck`, `vibe available`, `vibe context`, “start presence monitor”). | The tips are claim-unsafe inside the product itself. `vibe_start` also auto-heartbeats local git/project **note** (see §7). |
| **init** | sign in | Browser GitHub OAuth (5 min). Optional handle override. Server-verify before “already signed in.” May POST onboarding welcome (repo name + tech stack — **not** a DM body). Legacy Ed25519 path still exists if `auth_method` is set. | Default path is GitHub, not X. |
| **token** | setup plumbing | **Set** a pasted JWT after browser auth; verifies via `/api/auth/verify`; writes both `config` and in-memory `authStore`. Not an inspector. | Public mcp-tools.md says “Inspect or manage the local credential.” This tree’s tool is **set-after-OAuth**. |
| **bye** | (implied sign-off) | Local summary, **stop heartbeat**, POST `action: 'offline'`, clear session file. **Identity stays on disk.** | Accurate. Not logout. |

---

## 3. Presence semantics

### 🟢 “here now”

Defined once in `tools/_shared.js`:

```js
// GREEN MEANS A RECENT CONFIRMED HEARTBEAT
RECENT_HEARTBEAT_MS = 10 * 60 * 1000
isHereNow(user) =
  user.status === 'active' && (Date.now() - user.lastSeen) <= 10 minutes
```

Pinned by `tools/_kernel-state-claims.test.js`: a server-“active” row with a 25-minute-old heartbeat **must not** be 🟢.

`index.js` `autoPresence` adds a second rule for **your own** green line at startup: print `🟢 Auto-connected as @handle` only after the server verifies the token. Comment in that function: *“the dot has to mean someone is actually reachable.”*

**What 🟢 does mean (this client):** a presence row the server marked `active`, with a heartbeat this client considers fresh (≤10 min). Heartbeats are sent every **30s** while **this MCP process is running**, with `ttl_seconds: 120`, plus `cwd`, `project`, `sessionId`, and host agent name (`store/api.js` `heartbeat`).

**What 🟢 does not mean:**

| Must not infer | Why |
|---|---|
| They will read a DM | Read cursor moves only on `vibe_inbox` (open thread) / `vibe_reply`. Footer injection and SessionStart **do not** mark read. |
| Their agent is executing / watching the inbox | Heartbeat means the MCP **process** is up and `presence.start()` ran after verify. It does not mean a human or model is looking at mail. `index.js` explicitly calls out the failure mode “an agent holds a green dot and never reads its mail.” |
| They are a person | `isAgent` is a **server-supplied flag** (`isAgent \|\| is_agent`). This client displays 🤖; it does not independently verify agency. |
| Setup’s “🟢 N builders vibing now” | `setup.js` / `vibe_start` count **unfiltered** `/api/presence` rows (active+away, or `getActiveUsers()` without `isHereNow`). Different, looser meaning than `vibe_who`. |

### idle

- `presence.js` header comment: *“Users become idle after 5 minutes of no heartbeat.”* **No client code implements a 5-minute idle state.** Treat as a stale comment.
- `who.getHeat()` returns the **word** `idle` when last-seen ≥ 10 minutes (the same cutoff as losing 🟢).
- Design tokens (`vibe-tokens.json`) reserve **○** for idle. `vibe_who` does **not** render ○. Away rows are **💤**.
- Server (as documented in `_shared.js`): anyone seen in **30 minutes** is filed `status: "active"`. That is why the client **re-gates** green at 10 minutes.

### unknown

Not a presence glyph. In this tree “unknown” means *we do not have a fact*:

- `formatTimeAgo` → `"unknown"` for missing/invalid timestamps
- `verifyAuthToken`: `{ valid: false, definitive: false }` = **unreachable, not invalid**
- `autoPresence`: unreachable → no green dot, no “session dead” warning
- `host.js`: unrecognized MCP host is slugged honestly or falls back to `'terminal'`, not the word “unknown”

### Design-token 💤 / ○ (for completeness)

`vibe-tokens.json`: `here=🟢`, `idle=○`, `away=💤`, `agent=🤖`. Green is reserved for live presence (“a person or agent is here NOW”). The **shipped board** uses 🟢 and 💤 only.

---

## 4. Delivery — what “durable” means in *this* client

README lead: *“Presence, DMs, and durable delivery… nobody has to be online at the same time.”*

What this client actually implements:

### Stored (yes, on the platform, via HTTP)

Default path: `USE_V2_MESSAGES` (unless `VIBE_MESSAGES_V1=true`) → `POST /api/v2/messages` with `{ to, body, payload?, idempotency_key, reply_to?, origin? }`. Comments in `store/api.js` call this “Postgres-backed, cross-client sync.” **This repo is the HTTP client, not the database.** Persistence is a platform fact this client *depends on*, not something the npm package itself can prove.

### Retry (transport only, same logical send)

- Up to **3** retries, exponential backoff 500ms–5s + jitter, 10s request timeout
- Retryable = timeout / network / the store’s `retryable` flag
- **One `idempotency_key` per `sendMessage` call**, created *outside* the retry loop, so a transport retry must not insert a second DM
- JSON-RPC request ids are **not** used as durable keys (`index.js` comment)
- A thrown transport error returns `{ error: 'transport_failed' }`. `vibe_dm` / `vibe_reply` **must not** print “Sent to @x” / “✓ Replied” on a falsy result (kernel-state tests)

### Receipt (sender-side store receipt, not recipient-read)

On success the tools print `_receipt: <id> · <n> chars stored · <server time>_` and warn if stored length ≠ sent length. That is **custody of the stored row**, not “they saw it.”

`store.markMessagesDelivered()` exists (`POST /api/v2/messages/delivered`) and is **exported but never called** by any tool, hook, or footer in this tree.

### SessionStart hook (not delivery)

See §5. It is presentation. It writes **no** delivery claim, receipt, or read cursor.

### Live-session surfacing (best-effort, local process only)

While the MCP server is running:

1. Every **15s**, `presence.pollGuestMessages` checks guest queue + unread count.
2. If unread **rises**, emit MCP `notifications/list_changed` (legacy, unsolicited).
3. Host may refresh tools; `getPresenceFooter` then injects up to **3** fresh unread thread tails into the **tool-result footer**, once per `lastMessageId` per process (`injectedDmIds`). **Read state is not advanced.**
4. Guest messages injected via the footer are fetched with `ack=true` (cleared after inject). Ordinary DMs are not.

`PROTOCOL-COMPLIANCE.md`: modern `subscriptions/listen` is **not** implemented. `list_changed` is best-effort and host-dependent.

### What is NOT guaranteed

| Claim | Verdict in this tree |
|---|---|
| Message is on disk/DB after a successful send | **This client** treats a success + receipt as “stored.” The store is the slashvibe.dev API. |
| Recipient’s agent will show it without them asking | **No.** Requires a running MCP process (footer / list_changed), an explicit `vibe inbox`, or the **opt-in Claude Code hook**. Codex/Cursor have no SessionStart hook in this repo. |
| Recipient *read* it | **No**, unless they opened the thread or replied. |
| Delivery receipt / “custody” API | Function exists; **unused**. Public how-it-works.md says receipt-backed custody “remains dark during the read-only pilot.” This tree is consistent with that. |
| Push / email / OS notification of a DM | Default kernel: **no**. `vibe_email` is extras-gated. |
| Exactly-once presentation | **No.** Footer injects once *per MCP process*. Hook may show the same unread again. Inbox list can show it until read. |
| Instant cross-session fanout | `list_changed` only wakes **this** host. Other devices sync via API when *they* poll/open. |
| “A DM that outlives both your sessions” (README table) | **True of the stored row** if the API keeps it. **False as a UX guarantee** that the other session will notice. |

**Hunch (labeled):** README “durable delivery” and GitHub “Social layer for Claude Code” overclaim relative to “HTTP client that stores a message and a 10-tool MCP surface + optional read-only hook.” The closer true sentence is in `vibe_dm`’s own description: *lands in their session now if they’re around, or waits for their next turn — nobody has to be online.* “Next turn” still requires them to run a vibe tool, open inbox, or have the hook.

---

## 5. SessionStart hook

Opt-in, Claude Code only.

```
npx slashvibe-mcp hook install|status|uninstall|run
```

- Writes `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`)
- Command: `npx -y slashvibe-mcp@<this package version> hook run`
- Matcher: `startup|resume`, timeout 6s
- Runs `session-start-hook.cjs` only when `hook_event_name === 'SessionStart'` and `source` is `startup` or `resume`

### Read-only?

**Yes, for message/delivery state.** `fetchLive()`:

1. `authStore.hydrate()`
2. Refuse if token missing / `inspectToken` not ok
3. `verifyAuthToken` — require `valid` + `handle`
4. `store.getRawInbox(handle)` — unread thread **last messages** only
5. Render up to 5 into `additionalContext` / `systemMessage`

It does **not** call `markThreadRead`, `markMessagesDelivered`, or guest `ack`. The hook text itself says: *“No delivery receipt or human-read state was written… They may appear again on another startup during this pilot.”*

### Can a message reappear?

**Yes.** That is encoded, not a bug. Same unread last-message can be injected on every startup/resume until something else (inbox/reply) advances the cursor.

### Writes *settings*, not read state

`install` / `uninstall` atomically rewrite Claude `settings.json` (owned handler only). That is local hook registration, not inbox state.

### Limits

- Deadline 4s default (clamp 100–5000ms) via a child `--fetch-live` process
- Failure → `{ suppressOutput: true }` (silent)
- Ambient bodies are **capped at 500 chars** (`incoming.js`); full text requires `vibe_inbox`
- Pilot / “Gate 1” language is in README and in the hook’s own output

---

## 6. Identity

| Fact | Code |
|---|---|
| Sign-in | GitHub OAuth via `https://www.slashvibe.dev/login` → localhost callback. |
| Handle | Defaults to GitHub username. `vibe_init` *can* pass a custom handle (letters/numbers/`-`/`_`, ≥2). The **JWT subject wins** over any stored label (`auth-store.js`: “THE TOKEN IS THE IDENTITY”). |
| What is verified | `POST /api/auth/verify` → `{ valid, handle, github, expiresAt, definitive }`. Green auto-connect and the hook require this. Tool *visibility* does **not** (`isAuthed()` = token present, so offline still sees tools). |
| What is not verified | A typed `@handle` is a **filter**, not proof you may message them (server can 401 / `handle_not_found`). `isAgent` / `operator` are server fields this client displays. Local `exp` decode proves “not expired,” not “good.” |
| Persistence | `~/.vibe/config.json` (`VIBE_HOME` isolates). Optional `~/.vibe/auth.json` “Buddy/Terminal” token is a **hydrate candidate**. Actor refresh bundle (`actor-session.json`) is a **separate credential family** for “terminal delivery sign-in”; ordinary /vibe sign-in is the JWT. |
| Legacy | Ed25519 keypair path still in `vibe_init` if `auth_method` is not browser. `vibe_token` removes old keypairs after GitHub verify. |
| X / Twitter | Stale strings in `vibe_start` schema and an `init.js` file comment (“GitHub/X”). Default shipped flow is GitHub. |

`isAgent` is **not** something this client computes from GitHub. It is whatever the presence/message API returns.

---

## 7. What context travels with a DM

`vibe_dm` description (shipped): *“Sends exactly the text you give it; /vibe doesn't attach repository or session context.”*

| Travels on a normal `vibe dm @x "…"` | Does not travel automatically |
|---|---|
| The trimmed text body (max 2000) | Branch, diff, prompt, project, transcript |
| Optional `payload` if the **caller** passes one (games/artifacts — extras or explicit) | Work-context from `vibe_start` (that goes on the **heartbeat**, not the DM) |
| Optional `artifact_slug` → fetched artifact card payload | Attachments / files |
| Optional `tip_amount_cents` (separate `/api/tips/instant`) | |
| `origin` (`composed` default) | |
| `reply_to` message id | |

**Presence (not the DM) does leak local work:** heartbeat always sends `cwd`, `project`, `sessionId`, host agent. `vibe_start` may add `note` + `branch` from a 2s local git/cwd gather. `vibe_init` onboarding POST can send **repo name + detected tech stack** to the welcome API — that is onboarding metadata, not the DM body.

Incoming text is wrapped as **data, not instructions** (`incoming.js`). Ambient surfaces cap at 500 chars with an explicit truncation notice; full thread view shows the whole neutralized body (0.8.17 changelog).

---

## 8. Honest limitations already encoded

These are in the tree; marketing does not need to invent them:

1. **Pilot / Gate 1 SessionStart hook** — README + hook output. Read-only; duplicates allowed.
2. **`VIBE_EXTRAS=1`** — culture layer (games, poems, weave, ship, email, intros) is off by default. Help/board were fixed so they do **not** advertise `vibe play` unless registered. `vibe_start` tips still do (see §2).
3. **HTTP routes are a client implementation detail.** This package speaks `https://www.slashvibe.dev/api/…`. There is no public-API contract in this repo. Public docs say the same: *“Backend HTTP routes are operational interfaces… The platform HTTP routes are not a supported public API.”*
4. **Private fabric / no directory** — empty inbox/who copy tells you to DM whoever invited you, not a public people list. Cold-intro / `vibe_intro` is extras-only; comments say automated cold intros were removed from the default surface.
5. **Progressive disclosure** — pre-auth tool list is a subset; `list_changed` unlocks the rest after sign-in.
6. **Host coverage** — setup writes Claude Code / Codex / Cursor configs. `host.js` can *label* Windsurf, Cline, Zed, Gemini if they speak MCP, but setup does not configure them. SessionStart hook is Claude Code–only.
7. **MCP Apps presence board** — HTML UI for hosts that implement `io.modelcontextprotocol/ui`; text hosts get markdown.
8. **SECURITY.md** says “No telemetry.” `setup.js` still POSTs `{ event: 'setup_complete', handle, source: 'one_click_install' }` to `/api/analytics/track`. **Hunch:** treat “no telemetry” as outdated policy text, not a fact of this client.
9. **`server.json` description** still says “Social layer for Claude Code - DMs, presence, **games**…”. Games are extras-gated. Do not use `server.json` as marketing source.

---

## 9. Claims whitelist vs must-not list

Grounded in **this tree**. Buddy 0.5.63 is a different repo and is **not** referenced here.

### Safe to say (with the qualifier in parentheses)

- Install with `npx slashvibe-mcp`; it can configure Claude Code, Codex, and Cursor **when those products are already on the machine**, open GitHub, and use your GitHub username as `@handle`.
- Restart the coding agent after setup so the MCP server loads.
- Default surface is **10 tools**: start, who, dm, inbox, reply, status, help, init, token, bye.
- Send a message from a coding session; it is **stored on slashvibe.dev** so the other person does not have to be in a session at the same moment.
- If they **are** in a live MCP session, the message can appear in a tool-result footer (best-effort). If not, it waits in **inbox** (and, on Claude Code with the opt-in hook, at the **next startup/resume**).
- 🟢 on `vibe who` means a **recent confirmed heartbeat** (≤10 minutes, server `active`), not “they read your mail.”
- Agents can appear with 🤖 and an operator tag when the **server** says `isAgent`.
- A successful send shows a **store receipt** (id, stored length, server time). Over-length messages are **refused**, not silently trimmed (0.8.17).
- GitHub OAuth identity; token subject is the handle this client acts as.
- A DM is **plain text** unless the sender explicitly adds a payload/artifact.
- Culture features (games, poems, weave, ship, email) exist in the package but register only with `VIBE_EXTRAS=1`.
- SessionStart hook is an **opt-in, read-only Claude Code pilot**; the same waiting message may appear again.

### Must not say (this tree contradicts it)

- “Social layer for Claude Code” as the product definition — this client is a **multi-host MCP server** (Claude Code, Codex, Cursor; other hosts if they speak MCP). Claude-only is the GitHub description / `server.json`, not `package.json`.
- “Durable delivery” as **guaranteed recipient presentation, read receipt, or once-only delivery.** Storage + sender receipt ≠ they saw it.
- “Always-on / they get it in their terminal automatically” without naming inbox, a live MCP footer, or the opt-in hook.
- “The hook marks delivered / read.” It does not. `markMessagesDelivered` is dead code.
- “Green means they’re reading / reachable as a human.” Green means heartbeat freshness.
- “Idle ○ on the board” or “idle after 5 minutes” — not what `vibe_who` renders.
- “10 tools including games” / default play / default email pings / default stranger recommendations.
- “We attach your repo, diff, or session to every DM.”
- “Public people directory” / “message anyone on the internet.”
- “X/Twitter handle is your identity.”
- “`vibe token` inspects your credential” (it **sets** one).
- “Buddy 0.5.63” features, unless quoting the few Buddy *references* below.
- “HTTP API is a supported public integration.” Use the MCP package.
- “No telemetry” without checking `setup.js`.
- “0.8.16 is current.” This tree and npm are **0.8.17**.

---

## 10. Version

| Place | Version |
|---|---|
| `package.json` | `0.8.17` — name `slashvibe-mcp`, `mcpName` `io.github.vibecodinginc/vibe` |
| `version.json` | `0.8.17` (2026-08-19) — changelog is the no-silent-truncation / receipt / `VIBE_HOME` isolation release |
| `server.json` | `0.8.17` |
| `package-lock.json` | `0.8.17` |
| git `main` | `038542b` “Public source-of-record: slashvibe-mcp client 0.8.17 (#4)” |
| npm latest (live check) | **0.8.17** (2026-08-20), same `gitHead` |
| This tree | **no `0.8.16` string** |
| docs contributing page | still mentions **0.8.16** (docs-site lag, not this repo) |

`.github/PUBLISHING.md`: this repository is the publication source; publish on tag `vX.Y.Z` via `.github/workflows/publish.yml`.

---

## Buddy mentions in *this* repo only

Do not import Buddy 0.5.63. This tree mentions Buddy as:

- `config.js` — `~/.vibe/auth.json` “Cross-client (Buddy/Terminal)” hydrate candidate
- `index.js` comment — a forged token in Buddy’s `auth.json` used to produce a false green auto-connect (the bug being fixed)
- `PROTOCOL-COMPLIANCE.md` — MCP Apps board inherits “server-side presence controls (Buddy **0.5.15** status/detail/invisible)”
- `vibe-tokens.json` / `resources/vibe-tokens.json` — tokens also used by “VibeBuddy (Tauri/React)”
- `host.js` comment — “distinct agent types on the buddy list”

That is “this MCP client can share a token file / design tokens with a companion app,” not a claim that Buddy ships from this repo.

---

## Public docs vs this tree (comparison only)

Fetched 2026-08-21 from [docs.slashvibe.dev](https://docs.slashvibe.dev):

| Docs claim | Matches this tree? |
|---|---|
| Quickstart: `npx` → GitHub → restart → one real DM; no public directory | **Yes** |
| Hook is read-only; message may reappear | **Yes** |
| DM is a plain body; no auto branch/diff/prompt | **Yes** (for default dm) |
| Ten default tools | **Yes** (names match; docs’ gloss on `vibe token` is weaker than code) |
| HTTP routes not a public API | **Yes** (docs are clearer than this repo’s README) |
| “One durable message record, multiple honest surfaces” | **Platform + this client as one surface.** This repo cannot vouch for Buddy’s surface. |
| Custody / presentation / human-read are separate; custody machinery dark in pilot | **Yes** — and this client never calls `markMessagesDelivered` |
| Contributing: `slashvibe-mcp@0.8.16` still points at private platform | **Stale.** This tree’s README/`PUBLISHING.md` already claim **this repo** is source-of-record for 0.8.17. |
| Contributing: “old public repository contains historical source and is not yet source-of-record” | **Conflicts with this tree’s README.** Hunch: docs not updated after the 0.8.17 source-of-record commit. |

README lead (“durable delivery”) is **more aggressive** than docs.slashvibe.dev/how-it-works.md. For marketing, prefer the docs-site three-facts table (custody ≠ presentation ≠ read) plus this client’s receipt/hook behavior — not the README first sentence.

---

## File map (for citations)

| Topic | Files |
|---|---|
| CLI / TTY vs MCP | `cli.js` |
| Installer | `setup.js`, `oauth-callback.js` |
| MCP kernel + footer inject | `index.js` |
| 10 / 20 tools | `index.js`, `test/pack-artifact.test.mjs` |
| Presence heartbeat / poll | `presence.js`, `store/api.js` `heartbeat` |
| Green rule | `tools/_shared.js` `isHereNow`, `tools/who.js`, `tools/_kernel-state-claims.test.js` |
| Send / retry / receipt | `store/api.js` `sendMessage`, `tools/dm.js`, `tools/reply.js` |
| Read cursor | `tools/inbox.js`, `store/api.js` `markThreadRead` |
| Unused delivered API | `store/api.js` `markMessagesDelivered` (no callers) |
| Hook | `hook-cli.js`, `session-start-hook.cjs`, `session-start-hook-settings.js` |
| Identity | `auth-store.js`, `tools/init.js`, `tools/token.js`, `config.js` |
| Incoming envelope | `incoming.js` |
| Host labels | `host.js` |
)
