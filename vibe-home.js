/**
 * THE identity-directory definition. Every reader and writer of identity state
 * (config.json, auth.json, actor-session.json, session files) derives its base
 * directory here — nowhere else.
 *
 * Why one module (Stage-0 incident, 2026-08-19): three call sites each held
 * their own opinion of "where identity lives", and two of them were wrong in
 * different ways:
 *
 *   - setup.js hardcoded ~/.vibe/config.json, so running an ISOLATED setup
 *     (VIBE_HOME=~/.vibe-vibetester1) silently overwrote the machine's normal
 *     profile — the exact cross-identity write isolation exists to prevent;
 *   - config.js tested `process.env.VIBE_HOME ?`, so an EMPTY VIBE_HOME fell
 *     through to the shared default, and its legacy fallback read the shared
 *     ~/.vibecodings/config.json even when VIBE_HOME pointed elsewhere —
 *     an isolated session could silently ADOPT the shared identity.
 *
 * Rules:
 *   - unset            → ~/.vibe (the normal single-identity machine)
 *   - set, non-empty   → that directory, ~-expanded and resolved
 *   - set, empty/blank → THROW. The operator asked for isolation and named no
 *     directory; guessing either answer silently merges identities. Fail loud.
 *   - isolated sessions never read the legacy shared fallback (config.js).
 */

const os = require('os');
const path = require('path');

function homeDir(env) {
  return env.HOME || os.homedir();
}

/** True when this process was asked to run as an isolated identity. */
function isIsolated(env = process.env) {
  return env.VIBE_HOME !== undefined;
}

/** The identity base directory. Throws on a set-but-empty VIBE_HOME. */
function vibeHome(env = process.env) {
  const raw = env.VIBE_HOME;
  if (raw === undefined) return path.join(homeDir(env), '.vibe');
  const trimmed = String(raw).trim();
  if (!trimmed) {
    throw new Error(
      'VIBE_HOME is set but empty — refusing to guess an identity directory. ' +
      'Unset it to use ~/.vibe, or point it at an isolated directory ' +
      '(e.g. VIBE_HOME=~/.vibe-tester).',
    );
  }
  return path.resolve(trimmed.replace(/^~(?=$|\/)/, homeDir(env)));
}

module.exports = { vibeHome, isIsolated };
