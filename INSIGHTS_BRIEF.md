# /vibe insights — Funnel-First Integration Brief

## The Goal

Make insights the **zero-friction entry point** to /vibe. Anyone using Claude Code, Cursor, or any MCP client gets value immediately — no signup, no auth, no friction.

**Key insight**: Git handle is already on every machine. Use it as passive identity until they opt into the social layer.

---

## Funnel Stages

### Stage 0: Passive Value (No Action Required)

**Who**: Anyone with vibe-mcp installed
**Identity**: Git handle auto-detected (`git config user.name` or `user.email`)
**Data**: 100% local (`~/.vibe/work-patterns.json`) — never transmitted

What they get:
- Session rhythm (when they work, how long)
- State patterns (shipping vs debugging vs deep work)
- Module affinity (where they spend time)
- Peak hours visualization

**Trigger**: Just using the MCP server. Every tool call quietly logs to patterns.

**No vibe init required. No API calls. No network.**

### Stage 1: Curiosity ("vibe insights")

User says "show my coding patterns" or "vibe insights"

They see:
```
═══ Your Patterns ═══
_Local only_

**Work**
47 sessions · 38h total
avg 48m · longest 3h 12m
peak: 10:00, 14:00, 21:00
usually: shipping (62%)
focus: tools/, store/, index.js

**Creative**
12 ships · 8 ideas
domains: #mcp #presence #social

────────────────────
_since 14d ago_
```

**Still no network. Still no account.**

### Stage 2: Social Curiosity ("who else works like me?")

This is where /vibe social kicks in. The hook:

> "Want to see who else ships at 2am? `vibe init` to join the room."

Or after showing insights:
> "3 people online right now have similar patterns. `vibe init` to connect."

**This is the conversion moment.** They've seen value. Now they want more.

### Stage 3: Full /vibe (Existing Flow)

`vibe init` → GitHub OAuth → handle confirmed → presence, DMs, discovery

Their local patterns can optionally sync to their profile (opt-in):
- Public: peak hours, dominant state, shipping frequency
- Private: specific files, repos, session details

---

## Implementation Checklist

### 1. Enable insights without init (CRITICAL)

Current `tools/insights.js` has:
```javascript
const initCheck = requireInit();
if (initCheck) return initCheck;
```

**Change to**: Allow insights without init. Use git handle as fallback identity.

```javascript
async function handler(args) {
  // Insights works without vibe init — uses git handle
  const handle = config.getHandle() || getGitHandle();

  // ... rest of handler
}

function getGitHandle() {
  try {
    const name = execSync('git config user.name', { encoding: 'utf8' }).trim();
    return name.toLowerCase().replace(/\s+/g, '-');
  } catch {
    return 'anonymous';
  }
}
```

### 2. Register the tool in index.js

Add to `toolEntries` array:
```javascript
['vibe_insights', () => require('./tools/insights')],
```

Add annotation:
```javascript
vibe_insights: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
```

### 3. Auto-log patterns from all tool calls

In `index.js` after tool execution, log the event:
```javascript
// After successful tool call
patterns.logToolCall(params.name, args);
```

Key events to track:
- `vibe_ship` → creative.ships
- `vibe_dm` → social.messagesSent
- `vibe_react` → social.reactionsGiven
- `vibe_status` with mood → states
- Any tool call → sessions activity

### 4. Add conversion hooks to insights output

After displaying patterns, add contextual nudges:

```javascript
// At end of insights display
if (!config.isInitialized()) {
  const online = await store.getActiveUsers().catch(() => []);
  if (online.length > 0) {
    display += `\n\n---\n`;
    display += `**${online.length} builders online now.** \`vibe init\` to connect.`;
  }
}
```

### 5. Git handle → vibe handle continuity

When user does `vibe init`:
1. Detect their git handle
2. Pre-fill it as suggested vibe handle
3. If they keep it, their local patterns seamlessly become their profile

```javascript
// In tools/init.js
const gitHandle = getGitHandle();
const suggestedHandle = args.handle || gitHandle;
// ... OAuth flow
// After auth, if handle matches git handle, patterns.json is already "theirs"
```

---

## What NOT to Do

- Don't require network for insights
- Don't require vibe init for insights
- Don't transmit patterns without explicit opt-in
- Don't make insights feel like surveillance — it's self-reflection
- Don't show empty state frustration — even 1 session shows something

---

## Success Metrics

1. **Insights usage without init** — people use it before signing up
2. **Init conversion from insights** — % who init after seeing insights
3. **Pattern richness at init time** — they arrive with history, not cold

---

## Naming Options

The tool is `vibe_insights`. User-facing trigger phrases:
- "show my patterns"
- "vibe insights"
- "how do I work"
- "my coding rhythm"

Could also be its own surface: `/insights` as a lighter brand that feeds into `/vibe`.

---

## Files to Modify

1. `tools/insights.js` — remove requireInit, add git handle fallback, add conversion hooks
2. `index.js` — register tool, add pattern logging to tool call flow
3. `intelligence/patterns.js` — add `logToolCall()` helper
4. `tools/init.js` — pre-fill git handle, preserve pattern continuity
5. `config.js` — add `getGitHandle()` utility

---

## The Pitch

> /vibe insights shows you how you work — sessions, patterns, peak hours — all local, all private. When you're ready to see who works like you, `vibe init` connects you to the room.

Zero friction. Value first. Social second.
