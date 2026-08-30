/**
 * The truthful local capability manifest — the runtime kernel's one answer to
 * "what can this install actually do, right now, for this person?"
 *
 * Canon (platform PR #333 / epic #329): the runtime COORDINATES capabilities;
 * it does not ingest or centralize them. Discovery must not read private data
 * or silently install anything. Every capability reports exactly one of:
 *
 *   granted     — an explicit, revocable grant exists and the capability works
 *   available   — the provider is present locally; no grant yet (or none needed)
 *   off         — the person turned it off (env flag); presence not probed
 *   unavailable — no provider detected; said plainly, never guessed around
 *
 * Detection is EXISTENCE-ONLY: fs.existsSync / lstat on well-known paths and
 * PATH entries. No file contents are read here except the Mind bearer's
 * permission bits (personal-mind.js, which reads its own 0600 token — that IS
 * the grant). No subprocess runs. No network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const personalMind = require('./personal-mind');

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);

function envOff(name) {
  return OFF_VALUES.has(String(process.env[name] || '').toLowerCase());
}

function onPath(binary) {
  const entries = String(process.env.PATH || '').split(path.delimiter);
  return entries.some((dir) => {
    try {
      return dir && fs.existsSync(path.join(dir, binary));
    } catch {
      return false;
    }
  });
}

function vibeCheckPresent() {
  // Stan's collector: the db location is its documented contract. Existence
  // only — the database is never opened by discovery.
  return (
    fs.existsSync(path.join(os.homedir(), '.vibe-check', 'vibe_check.db')) ||
    onPath('vibe-check')
  );
}

function vibeStatsProvider() {
  // Provider contract: an executable named `vibestats`, or an explicit path
  // in VIBE_STATS_CLI. Existence only; never executed during discovery.
  const explicit = process.env.VIBE_STATS_CLI;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  return onPath('vibestats') ? 'vibestats' : null;
}

/**
 * The manifest. Pure with respect to the wire: nothing here talks to the
 * platform or any provider — states describe THIS machine, honestly.
 */
function manifest() {
  const message = config.isInitialized()
    ? { state: 'granted', why: 'signed in as one /vibe principal' }
    : { state: 'available', why: 'runtime installed; sign in with vibe start' };

  let remember;
  if (envOff('VIBE_REMEMBER')) {
    remember = { state: 'off', why: 'VIBE_REMEMBER is off; providers not probed' };
  } else if (personalMind.isAvailable()) {
    remember = { state: 'granted', why: 'Personal Mind activation present (revocable: remove the activation file)' };
  } else if (vibeCheckPresent()) {
    remember = { state: 'available', why: 'VibeCheck detected locally; no Mind grant activated' };
  } else {
    remember = { state: 'unavailable', why: 'no local memory provider detected' };
  }

  let reflect;
  if (envOff('VIBE_REFLECT')) {
    reflect = { state: 'off', why: 'VIBE_REFLECT is off; providers not probed' };
  } else {
    const provider = vibeStatsProvider();
    reflect = provider
      ? { state: 'available', why: `VibeStats provider present (${path.basename(provider)})` }
      : { state: 'unavailable', why: 'no local VibeStats provider detected' };
  }

  const call = envOff('VIBE_CALL')
    ? { state: 'off', why: 'VIBE_CALL is off' }
    : { state: 'available', why: 'explicit live-room handoff via calljimmy.ai; nothing joins without a person' };

  return {
    message: { provider: '/vibe', ...message },
    remember: { provider: 'vibecheck', ...remember },
    reflect: { provider: 'vibestats', ...reflect },
    call: { provider: 'vibeconf', ...call },
  };
}

const STATE_GLYPH = { granted: '●', available: '○', off: '·', unavailable: '—' };

function renderLine(verb, cap) {
  return `${STATE_GLYPH[cap.state] || '?'} ${verb} — ${cap.state} · ${cap.why}`;
}

function render(m = manifest()) {
  return ['remember', 'reflect', 'message', 'call']
    .map((verb) => renderLine(verb, m[verb]))
    .join('\n');
}

module.exports = { manifest, render, _detect: { envOff, onPath, vibeCheckPresent, vibeStatsProvider } };
