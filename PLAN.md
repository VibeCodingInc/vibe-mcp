# /vibe — Product Plan

**Position:** The presence layer for AI-mediated work.

Not a social network for devs. Not Slack for terminals. The real-time awareness substrate for the agent+human+tool paradigm that MCP created.

Slack is human-to-human async. GitHub is artifact-centric. /vibe is presence + agents + sessions — the new territory where AI-mediated collaboration happens.

---

## Current State (Feb 2026)

- 42 registered tools (stripped from 44 — games and tag suggestions removed)
- Presence, messaging, sessions, memory, discovery, artifacts, file coordination
- SQLite session journal (durable, resumable)
- 8 bridge integrations (Discord, Telegram, Farcaster, WhatsApp, X)
- Intelligence layer (serendipity, proactive discovery)
- Published on npm (0.3.24), Glama, Smithery
- 7-editor support (Claude Code, Cursor, VS Code, Windsurf, Cline, Continue.dev, JetBrains)
- Universal installer: `npx slashvibe-mcp install`
- 496 tests passing

**No direct competitors.** Closest is Slack MCP (workplace, not dev-social). Category is uncontested.

---

## Phase A: Distribution Saturation

**Timeline: 48 hours. No debate, just execute.**

### A1. MCP Registry (table stakes)
- [ ] `mcp-publisher login github`
- [ ] `./scripts/publish-registry.sh`
- Namespace ready: `io.github.vibecodinginc/vibe-mcp`

### A2. Cursor Directory (the real prize)
- [ ] Submit to Cursor's MCP directory
- [ ] Optimize description for 250K+ monthly active developers browsing MCPs

### A3. All Marketplaces
- [ ] MCP.so (3,000+ servers)
- [ ] claudecodemarketplace.net (1,261 servers, community voting)
- [ ] mcpmarket.com
- [ ] mcpservers.org

### A4. GitHub SEO
- [ ] Add `mcp-server` topic to repo
- [ ] Ensure README keywords match marketplace search terms

### A5. README GIF
- [ ] Record 15-second terminal capture: `vibe start` -> presence changing -> DM arrives
- [ ] Add above the fold in README
- [ ] This alone converts more installs than half the listings

---

## Phase B: MCP Apps — The Inflection Point

**This is the bet.** MCP Apps (Jan 2026 spec) let servers render interactive UI directly in chat. VS Code Insiders supports it. Nobody has built social UI with it yet.

### B1. Presence Widget (the keystone)

**Ship this first. If you ship one thing from Phase B, ship this.**

A live buddy list that renders inline in chat. Who's online, what they're building, unread count. Updates on every response.

Why this matters:
- Creates ambient awareness (you *see* people, not just query for them)
- Reframes /vibe from "commands" to "environment"
- Glanceable — no interaction required to get value
- If people see other builders while coding, behavior changes immediately

Implementation:
- MCP Apps resource that returns presence HTML/React component
- Heartbeat-driven updates (every response refresh)
- Compact layout: handles + status indicators + unread badge
- Fall back to text for clients without Apps support

### B2. Presence Widget v2 (polish)

- Activity indicators (typing, shipping, deep focus)
- "3 people shipped in the last 10 minutes" ambient signal
- "You and @bob are touching the same repo" proximity alert
- These are NOT a feed. No timeline, no scrolling. Just signals.

### B3. Session Context Card

When `vibe_session_resume` fires, render a rich card:
- Timeline visualization
- Participants with avatars
- Tool activity distribution
- Key moments (messages, ships, handoffs)

This is retention, not acquisition. Matters after people already care.

### B4. DM Composer

Inline form with handle autocomplete, tone selector, send button.
Secondary to presence. Text commands are fine for power users. Visual presence is what converts normals into daily users.

---

## Phase C: Network Density

### C1. Shared Sessions (the Google Docs moment)

Two developers `vibe_session_join` and see each other's tool calls in real time.

Why this moves up:
- Instantly demo-able
- Obviously valuable
- Hard to copy (social, not technical, moat)
- Pairs perfectly with presence UI

Implementation:
- WebSocket or SSE channel per session
- Journal entries broadcast to all session participants
- Presence widget shows co-editors in session
- "Pair programming" but for the agent era

### C2. Cross-Editor Notifications

When someone @mentions you and you're offline, deliver via bridge layer:
- Discord DM
- Telegram message
- Email digest

Bridges exist (`bridges/`). Wire them to the notification path. This is retention — people come back because they know they'll be found.

### C3. Ambient Activity Intelligence

The `intelligence/serendipity.js` module exists. Surface it:
- "3 people shipped in the last 10 minutes"
- "You and @alice are both working in vibe-mcp"
- "@bob just came online after 3 days"

**Not a feed.** Ambient signals in the presence widget or footer. No timelines, no scrolling.

---

## Phase D: Infrastructure Lock-in

### D1. Session History as Portfolio

This is not a nice-to-have. This is how /vibe escapes being "just another dev tool."

If GitHub shows what you built, Vibe shows how you think while building.

- Public profile page on slashvibe.dev
- Session history, shipping frequency, collaboration graph
- Opt-in (privacy first)
- Embeddable badge for GitHub profile

A fundamentally new professional asset.

### D2. Third-Party Presence API (the endgame)

Let other MCP servers route presence through /vibe.

If the GitHub MCP server can show "seth is reviewing PR #42" in the buddy list,
/vibe becomes the social layer for the *entire* MCP ecosystem.

When this works:
- Competition stops mattering
- Switching costs appear naturally
- /vibe becomes invisible but indispensable

This is the Stripe moment. Don't rush it. Build toward it.

---

## The Existential Metric

**Average concurrent visible users per active coder.**

If presence doesn't feel alive within 30 seconds, people uninstall.

### Seeding Strategy

Until organic density exists:
- Own agents show presence (building, shipping, reviewing)
- Early adopters highlighted by default
- "Recently active" section for users who were here in the last hour
- Dead social surfaces kill products. Keep it alive.

---

## What We Stripped (and Why)

Removed from tool registry (files kept on disk for potential future use):
- `vibe_game` — 25 games. Fun but dilutes the "presence layer" message. Every tool in `tools/list` is a signal to the LLM about what /vibe is. Games say "toy." Presence tools say "infrastructure."
- `vibe_suggest_tags` — Content/social feature, wrong layer for presence.
- X posting tools (x-mentions, x-reply) — Were never registered. Dead files.

Kept tictactoe as a latent capability in the codebase. The wink stays, but it doesn't take up a tool slot.

---

## Priority Stack

| # | What | Why | When |
|---|------|-----|------|
| 1 | MCP Registry publish | Table stakes | Now |
| 2 | Cursor directory | 250K devs | Now |
| 3 | All marketplaces | Legitimacy | This week |
| 4 | README GIF | Conversion | This week |
| 5 | Presence widget (MCP Apps) | Category-defining | Next sprint |
| 6 | Presence widget v2 | Ambient signals | Next sprint |
| 7 | Shared sessions | Network effect | Next |
| 8 | Cross-editor notifications | Retention | Next |
| 9 | Session context card | Retention | Next |
| 10 | Portfolio pages | Lock-in | Later |
| 11 | Third-party presence API | Endgame | Later |

---

*If we nail presence as a first-class UI, /vibe won't just hold #1 — it becomes the default social substrate of the MCP ecosystem.*
