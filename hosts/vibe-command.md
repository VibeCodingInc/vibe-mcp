---
description: From the work in this session, suggest up to three ways to connect on /vibe, prepare the message, and let me choose what to send. Nothing sends until I choose "Send to @handle".
---

The person wants to connect with someone on /vibe using what you already know about this session. Human-approved does not mean human-typed: you prepare, they choose. Follow these steps exactly.

1. **Summarize the work in their terms, from what this session already holds** — the files and commits touched, what was just fixed or is stuck, what they said they wanted: `project` (a name), `doing` (one line), and if present `result` (one or two sentences), `question` or `blocker`, and `refs` (links they clearly want attached: a PR, a doc, an artifact). Never include file paths, branch names, secrets, or transcript text. `$ARGUMENTS` is optional: when given, treat it as the question or result they want to send; when empty, do not ask them to restate anything — use the session. If the session holds no work yet, say so in one line and ask what they are working on.

2. **Call `vibe_moves`** with that context. It returns up to three **candidates** (each: a named recipient, the evidence for naming them, a prepared draft) — or none, with one question. Zero useful moves is a valid answer: say "no useful move from this work right now" and, if the tool asked something, ask it; never manufacture a move.

   **Judge the candidates before showing any.** You know things the tool does not. Drop a candidate when its recipient is wrong for this work, when its draft does not actually address that person's question, or when you know the handle is a test/QA account. A mismatch you have recognized must never remain a recommended choice — drop it or, if the recipient is right but the text is not, rewrite it later through Edit (never silently). If nothing survives, say so.

3. **Offer the surviving candidates — this step opens a draft, it never sends.** Title the question "Open a draft?" (never "Send it"). Use the native question control if this host has one. Claude Code: AskUserQuestion with one option per candidate (label it "Draft: <label>", evidence in the description) plus **"not now"** — at most four options; the person can always pick the built-in "Other" to write their own, so do not add a "write my own" option. Offer exactly as many as survived — one if one — never pad with contacts the tool did not name. Otherwise print them numbered, then "0 = write my own, n = not now", and ask for a number. Selecting sends nothing.

4. **On a choice, call `vibe_draft`** with the move's id (or, for "write my own", with `handle` and `message` after asking what to say). Show the person exactly what it returns: the recipient, the exact message, the attachments.

5. **Offer the three actions**: `Send to @handle` / `Edit` / `Cancel` — native control if available, text otherwise.
   - **Send to @handle** → call `vibe_send_draft` with the id AND the `rev` from the preview you showed (the approval is bound to that exact text). That choice is the approval; do not ask "are you sure". Report what the tool says.
   - **Edit** → ask what to change, call `vibe_draft` again with the id and the new `message`, show the new preview, offer the three actions again.
   - **Cancel** → call `vibe_discard_draft` with the id. Nothing is sent.

Do not send by any other path during this flow. Fully written requests like "message @sam — …" are not this flow; handle them as before with `vibe_dm`.
