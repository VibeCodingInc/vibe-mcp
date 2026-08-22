/**
 * Terminal title (OSC 0) + iTerm2 badge (OSC 1337) — the ambient "online"
 * claims that live OUTSIDE the transcript.
 *
 * These two escapes say "N online" / ●N in the terminal chrome, so they are
 * presence claims like any other and pass the SAME isHereNow gate as the
 * vibe_start card, who and dm (#9.1 review: the card was fixed while a
 * stale/away-only room could still put "2 online" in the title bar).
 *
 * Lives in its own module because index.js starts the server on require —
 * this is the testable seam for the escape path.
 */

const { isHereNow } = require('./tools/_shared');

// Generate terminal title escape sequence (OSC 0)
function getTerminalTitle(onlineCount, unreadCount, lastActivity) {
  const parts = [];
  if (onlineCount > 0) parts.push(`${onlineCount} online`);
  if (unreadCount > 0) parts.push(`📩 ${unreadCount}`);
  if (lastActivity) parts.push(lastActivity);
  if (parts.length === 0) parts.push('quiet');

  const title = `vibe: ${parts.join(' · ')}`;
  return `\x1b]0;${title}\x07`;
}

// Generate iTerm2 badge escape sequence (OSC 1337)
function getBadgeSequence(onlineCount, unreadCount) {
  const parts = [];
  if (onlineCount > 0) parts.push(`●${onlineCount}`);
  if (unreadCount > 0) parts.push(`✉${unreadCount}`);
  const badge = parts.join(' ') || '○';
  const encoded = Buffer.from(badge).toString('base64');
  return `\x1b]1337;SetBadgeFormat=${encoded}\x07`;
}

/**
 * The ONLY export. Takes the RAW others list (active+away union) and applies
 * the recency gate here, so no caller can feed an ungated count into an
 * online claim — which is also why the two formatters above stay private:
 * exporting them would hand back the bypass this module exists to close.
 * @param {Array<{handle: string, status?: string, lastSeen?: number}>} others
 * @param {number} unreadCount
 * @returns {string} concatenated escape sequences
 */
function ambientEscapes(others, unreadCount) {
  const hereNow = (others || []).filter(isHereNow);
  const lastActivity = hereNow.length > 0 ? `@${hereNow[0].handle}` : null;
  return getTerminalTitle(hereNow.length, unreadCount, lastActivity)
    + getBadgeSequence(hereNow.length, unreadCount);
}

module.exports = { ambientEscapes };
