'use strict';

/**
 * Noticing: what the agent is shown and told so that it notices when the work
 * touches someone the person knows, and offers a message (as a draft) at that
 * moment. Text only: nothing here sends, and nothing here changes how a send
 * is checked (tools/drafts.js, confirm-box.js, turns.js).
 *
 * Lab 2026-11-21 (20 outside-written pairs): in 12 of the 18 pairs where one
 * person held something the other needed, the agent never drafted at all;
 * where it did draft, every message was sent by the person's choice. So the
 * weak point was noticing and offering. Each change is one switch below.
 *
 * VIBE_NOTICE_VARIANT=off restores the earlier texts, for lab comparison. It
 * is read ONLY when /vibe is a server on this machine (a loopback API URL):
 * a real account always gets the current texts.
 */

const NOTICE = {
  agentHereLine: true,      // 1. the agent's here-line: longer lines, "· open line"
  hereRelevance: true,      // 2. the here-line may be acted on when the work touches someone
  triggers: true,           // 3. ask-before-guessing, bump-before-another-fix, results that touch someone
  offerIsDraft: true,       // 4. the offer is the draft (vibe_prepare), not a question in prose
  replyFromProject: true,   // 5. a reply may come from the project's files, not only this session
};

/** The agent's copy of someone's line about what they are working on. The person's copy stays at 48. */
const AGENT_SAYS_MAX = 140;
const PERSON_SAYS_MAX = 48;

function isLoopback(env = process.env) {
  let url = env.VIBE_API_URL;
  if (!url) { try { url = require('./config').getApiUrl(); } catch { return false; } }
  let host;
  try { host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** True when the named change is on. `off` turns all of them off, and only against a loopback API. */
function on(name, env = process.env) {
  if (!NOTICE[name]) return false;
  if (String(env.VIBE_NOTICE_VARIANT || '').trim().toLowerCase() === 'off' && isLoopback(env)) return false;
  return true;
}

module.exports = { NOTICE, AGENT_SAYS_MAX, PERSON_SAYS_MAX, isLoopback, on };
