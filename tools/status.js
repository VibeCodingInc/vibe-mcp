/**
 * vibe status — Set your mood/status
 *
 * Now includes away/back functionality (previously vibe_away/vibe_back)
 */

const config = require('../config');
const store = require('../store');
const discord = require('../discord');
const { trackMood } = require('./summarize');
const { markAway, markBack, getProactiveSummary } = require('../intelligence/proactive');

const MOODS = {
  'shipping': '🔥',
  'thinking': '🧠',
  'afk': '☕',
  'debugging': '🐛',
  'pairing': '👯',
  'deep': '🎧',
  'celebrating': '🎉',
  'struggling': '😤',
  'away': '☕',    // Merged from vibe_away
  'back': null,   // Merged from vibe_back (clears status)
  'clear': null
};

// Special modes that toggle settings
const SPECIAL_MODES = ['guided', 'freeform'];

const definition = {
  name: 'vibe_status',
  description: 'Set your mood/status, or your notification pace. Mood: shipping, thinking, afk, debugging, pairing, deep, celebrating, struggling, away, back, clear. Pace: slower (only ping when away), quiet (no pushes), normal.',
  inputSchema: {
    type: 'object',
    properties: {
      mood: {
        type: 'string',
        description: 'A mood (shipping, thinking, afk, debugging, pairing, deep, celebrating, struggling, away, back, clear) OR a notification pace (slower, quiet, normal)'
      },
      message: {
        type: 'string',
        description: 'Optional away message (only used with away mood, e.g., "grabbing coffee")'
      }
    },
    required: ['mood']
  }
};

async function handler(args) {
  if (!config.isInitialized()) {
    return {
      display: 'Run `vibe init` first to set your identity.'
    };
  }

  const { mood, message } = args;

  // The schema marks mood required, but a host that doesn't enforce that used
  // to get a raw TypeError here. Missing input is a state with copy, not a crash.
  if (typeof mood !== 'string' || mood.trim() === '') {
    return {
      display: 'What mood? Say `vibe status <mood>` — shipping, thinking, afk, debugging, pairing, deep, celebrating, struggling, away — or "clear" to remove it.'
    };
  }

  const moodKey = mood.toLowerCase().replace(/[^a-z]/g, '');
  const handle = config.getHandle();

  // The "slower" primitive (ratified in the Living Room): one notification pace
  // across every surface, not a per-channel mute. `slower` = only ping me when
  // I've stepped away; `quiet` = hold all pushes (badge still updates); `normal`
  // = default. A first-class human command.
  const PACE = { slower: 'slower', quiet: 'quiet', normal: 'normal', faster: 'normal' };
  if (PACE[moodKey]) {
    const pace = PACE[moodKey];
    const result = await store.setNotificationPace(pace);
    if (result?.success === false) {
      return { display: `Couldn't set pace: ${result.error || 'unknown error'}` };
    }
    const blurb = {
      slower: '🐢 **slower** — you\'ll only get pushed when you\'ve stepped away. The board still shows everything, quietly.',
      quiet: '🤫 **quiet** — no pushes; unread still counts silently. Say `vibe status normal` to turn them back on.',
      normal: '🔔 **normal** — notifications back to default.',
    }[pace];
    return { display: blurb };
  }

  // Handle special modes (guided/freeform)
  if (moodKey === 'guided') {
    config.setGuidedMode(true);
    return {
      display: `**Guided mode enabled** ✨

You'll now see interactive option menus after each /vibe action.
Perfect for learning the commands.

_Say "set status freeform" to switch to text-only mode._`
    };
  }

  if (moodKey === 'freeform') {
    config.setGuidedMode(false);
    return {
      display: `**Free form mode enabled** ⚡

Option menus disabled. Just type what you want.
Commands: message, react, ping, status, context, etc.

_Say "set status guided" to re-enable interactive menus._`
    };
  }

  // Handle 'away' mood (merged from vibe_away)
  if (moodKey === 'away') {
    const awayMessage = message?.trim();

    // Validate message length
    if (awayMessage && awayMessage.length > 100) {
      return { display: '⚠️ Away message too long (100 char max)' };
    }

    // Set away status with optional message
    await store.setAwayStatus(handle, 'away', awayMessage || null);
    markAway();

    if (awayMessage) {
      return { display: `☕ away — "${awayMessage}"` };
    }
    return { display: '☕ away' };
  }

  // Handle 'back' mood (merged from vibe_back)
  if (moodKey === 'back') {
    // Clear away status
    await store.clearAwayStatus(handle);

    let display = '👋 back';

    // Check if anything happened while away
    const unreadCount = await store.getUnreadCount(handle).catch(() => 0);
    if (unreadCount > 0) {
      display += ` — ${unreadCount} unread`;
    }

    // Mark as back for proactive tracking
    markBack();

    return { display };
  }

  if (!MOODS.hasOwnProperty(moodKey)) {
    const options = Object.entries(MOODS)
      .filter(([k, v]) => v && k !== 'back')  // Exclude 'back' from list (it's a clear action)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    return {
      display: `Unknown mood. Options: ${options}, or "clear"/"back" to remove`
    };
  }

  const emoji = MOODS[moodKey];

  // Update presence with mood via context
  await store.heartbeat(handle, config.getOneLiner(), { mood: emoji });

  // Track for session summary
  if (emoji) {
    trackMood(emoji);
  }

  // Post to Discord if configured
  if (emoji) {
    discord.postStatus(handle, moodKey);
  }

  if (!emoji) {
    return { display: 'Status cleared.' };
  }

  return {
    display: `Status set: ${emoji} ${moodKey}\n\nOthers will see this next to your name.`
  };
}

module.exports = { definition, handler };
