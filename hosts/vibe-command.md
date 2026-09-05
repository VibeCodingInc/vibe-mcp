---
description: From the work in this session, suggest up to three ways to connect on /vibe, prepare the message, and let me choose what to send. Nothing sends until I choose "Send to @handle".
---

The person wants to connect with someone on /vibe using what you already know about this session. Human-approved does not mean human-typed: you prepare, they choose. Follow these steps exactly.

1. **Summarize the work in their terms**, from this session only: `project` (a name), `doing` (one line), and if present `result` (one or two sentences), `question` or `blocker`, and `refs` (links they clearly want attached: a PR, a doc, an artifact). Never include file paths, branch names, secrets, or transcript text. If $ARGUMENTS is given, treat it as the question or result they want to send.

2. **Call `vibe_moves`** with that context. It returns up to three moves (each: a named recipient, the evidence for naming them, a prepared draft) — or one question. If it returns a question, ask the person that question and stop; do not invent a recipient.

3. **Offer the moves as choices.** Use the native question control if this host has one (Claude Code: AskUserQuestion, one option per move using its label, plus "write my own" and "not now"). Otherwise print them numbered and ask for a number. Selecting sends nothing.

4. **On a choice, call `vibe_draft`** with the move's id (or, for "write my own", with `handle` and `message` after asking what to say). Show the person exactly what it returns: the recipient, the exact message, the attachments.

5. **Offer the three actions**: `Send to @handle` / `Edit` / `Cancel` — native control if available, text otherwise.
   - **Send to @handle** → call `vibe_send_draft` with the id. That choice is the approval; do not ask "are you sure". Report what the tool says.
   - **Edit** → ask what to change, call `vibe_draft` again with the id and the new `message`, show the new preview, offer the three actions again.
   - **Cancel** → call `vibe_discard_draft` with the id. Nothing is sent.

Do not send by any other path during this flow. Fully written requests like "message @sam — …" are not this flow; handle them as before with `vibe_dm`.
