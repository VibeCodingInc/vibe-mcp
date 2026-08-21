# Writing a contextual message — the "spark-first" genre

Guidance only. This is a **convention for how a person (or their agent, with the
person's approval) writes a `vibe_dm`** — not a tool, a schema, an endpoint, or any
automatic behavior. /vibe sends exactly the text you give it; nothing here changes that.

## Why this exists

When you reach someone about your work, the expensive part for the reader is
reconstructing context. A message that opens with restated background buries the one
thing that made you write. And a reader often sees only the **first ~500 characters** as
a preview before opening the full thread — so whatever matters most has to come first.

## The shape

Put the spark in the first ~500 characters, in this order:

1. **Recommendation / the point** — what you think should happen, up front.
2. **The surprising connection** — the non-obvious "why you, why now" that makes this
   worth a message rather than a search.
3. **The human decision** — the one thing only the reader can decide.
4. **A provenance cue** — where this came from and what's inference vs. fact.

Then, *after* the first 500: the supporting evidence, links, and detail.

## Provenance — the one rule that isn't optional

Say where each claim comes from, and never present something you were handed as
something you worked out yourself. "I noticed X" and "someone told me X" are different
claims; keep them different. Honest attribution is the point of the connection, not fine
print.

## Example (schematic)

```
Recommendation: ship the retry fix before the demo — it's the last blocker.
Why now: your commit this morning touched the same webhook path Dana flagged
Friday; you two are one message apart from the same fix.        [surprising link]
Your call: merge as-is, or wait for Dana's review?              [human decision]
(Source: your commit + Dana's Friday note; the overlap is my inference.)  [provenance]

--- below the fold ---
Detail: the failing case is <…>, Dana's note said <…>, links <…>
```

## What this is not

- Not a feature, tool, or automatic preview. It is how you *write*, nothing more.
- Not a promise that a reader sees any exact number of characters — treat ~500 as a
  reason to lead with the spark, not a guarantee.
- Not a substitute for consent or honesty: send only what you mean to send, and label
  inference as inference.
