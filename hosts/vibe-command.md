---
description: From the work in this session, notice one genuinely useful connection to another person, show why now and the exact message, and let me choose. Nothing sends until I choose "Send to @handle".
---

The person is already working. They typed `/vibe` and nothing else. Your job: notice one genuinely useful connection between this work and another person, show them who, a short "why now", and the exact message — then let them choose. They should not have to describe what they are building or invent the conversation. Follow these steps exactly.

1. **Understand the work from what this session already holds** — the files and commits touched, what was just fixed or is stuck, what they said they wanted. Keep that reasoning and its sources local. Give `vibe_moves` only what the person would say out loud: `project` (a name), `doing` (one line), and if present `result` (one or two sentences), `question` or `blocker`, and `refs` (links they clearly want attached). Never file paths, branch names, secrets, or transcript text. `$ARGUMENTS` is optional: if given, it is the question or result they want to send; if empty, do not ask them to restate anything. If the session holds no work yet, say so in one line and stop.

2. **Call `vibe_moves`.** It returns one strongest move (with alternatives if any) — each a named person, a **why now**, and the exact thing that person said or chose to share (`hook`) — or none, with one question. It connects the work only to something the recipient actually said or listed; recency and a green dot alone are never the reason. **Zero moves is a legitimate result:** say "no useful move from this work right now" and stop; never manufacture one.

   If it returned replies (`replies`): someone answered what the person sent from this work. Show that reply beside the work first, and suggest **one** next step in a sentence. Suggesting it authorizes nothing — do not act on the reply unless asked.

3. **Judge the strongest move before showing it.** Drop it if the recipient is wrong for this work, if a message would not actually respond to what they said, or if you know the handle is a test/QA account. A mismatch you recognize is suppressed — not shown with a warning. If it falls, take the next alternative through the same judgment; if none survive, say there is no useful move.

4. **Write the message yourself.** One to three specific sentences, from the work in this session, that respond to `hook` — what they asked, or what they said they are on. Not a summary of the session. Not a template. Not an invented conversation. If `reply_to` was given, keep it: it makes the reply verifiable on their side. Then call `vibe_draft` with `{ id, message, reply_to }` — this **opens a preview only**.

5. **Show the preview** exactly as returned: recipient, why now, the exact message, attachments. Then offer three actions with the native control if this host has one (Claude Code: AskUserQuestion): **Send to @handle** / **Edit** / **Not now**. If alternatives exist, one extra option "Show alternatives" is allowed (four options at most).
   - **Send to @handle** → call `vibe_send_draft` with the id AND the `rev` from the preview. That choice is the approval; do not ask again. Report what the tool says, once.
   - **Edit** → ask what to change, call `vibe_draft` again with the id and the new `message`, show the new preview, offer the actions again.
   - **Not now** → call `vibe_discard_draft` with the id. Nothing is sent.
   - **Show alternatives** → offer the surviving alternatives as "Draft: …" choices plus "Not now"; the chosen one goes through steps 3–5.

6. **On the receiving side it is the same loop.** When someone asked this person something and this session's work answers it, that is the strongest move: `vibe_moves` returns it with `reply_to` set. Write the answer from the work here, preview, and let them approve. Their session will see it beside the work it came from.

Do not send by any other path during this flow. A fully written request like "message @sam — …" is not this flow; handle it as before with `vibe_dm`.
