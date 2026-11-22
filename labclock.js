'use strict';

/**
 * The lab's clock, for DISPLAY only.
 *
 * A lab story runs a week of days in minutes, so a message from "yesterday"
 * was really sent four minutes ago, and every relative time the product shows
 * ("4m ago", "earlier today") says so (lab 2026-11-21). This lets a lab run
 * make the days real in what is shown, and nothing else:
 *
 *   VIBE_LAB_CLOCK_OFFSET_HOURS=H   "now", for display, is H hours later.
 *   VIBE_LAB_DAY_STARTS=1:t1,2:t2   when each lab day began (epoch ms, real
 *                                   clock). A time on or after t_k belongs to
 *                                   lab day k and is shown 24*(k-1) hours later,
 *                                   so today's events stay "just now" while
 *                                   yesterday's read as yesterday. Optional;
 *                                   without it times are shown as they are.
 *
 * The runner sets day d to H = 24*(d-1). Both are read ONLY against a loopback
 * API (notice.isLoopback), like every lab switch: a real account always sees
 * the real clock. Used where a relative time is rendered (store
 * formatTimeAgo, the session-start "since yesterday", vibe_people's "today",
 * "they wrote last · Nd ago", unsent's "last shown"). Never in a decision:
 * turns, the Send box, spool TTLs and age thresholds keep the real clock.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_HOURS = 24 * 366;

function offsetHours(env = process.env) {
  const raw = env.VIBE_LAB_CLOCK_OFFSET_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const h = Number(raw);
  if (!Number.isFinite(h) || h < 0 || h > MAX_HOURS) return null;
  return h;
}

/** On only when the offset is set and valid, and the API is on this machine. */
function active(env = process.env) {
  if (offsetHours(env) === null) return false;
  try { return require('./notice').isLoopback(env); } catch { return false; }
}

/** [{ day, at }] sorted by `at`, from "1:t1,2:t2"; malformed entries are dropped. */
function dayStarts(env = process.env) {
  return String(env.VIBE_LAB_DAY_STARTS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(\d{1,3}):(\d{1,16})$/.exec(x);
    if (!m) return null;
    const day = Number(m[1]); const at = Number(m[2]);
    return day >= 1 && day <= 366 && Number.isFinite(at) ? { day, at } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);
}

/** "Now" for display: the real now, or H hours later in a lab. */
function now(real = Date.now(), env = process.env) {
  if (!active(env)) return real;
  return real + offsetHours(env) * HOUR_MS;
}

/** A timestamp for display: moved to its lab day, or unchanged. Non-numbers pass through. */
function at(ts, env = process.env) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || !active(env)) return ts;
  let day = null;
  for (const s of dayStarts(env)) if (ts >= s.at) day = s.day;
  return day ? ts + (day - 1) * DAY_MS : ts;
}

module.exports = { now, at, active, offsetHours, dayStarts, HOUR_MS, DAY_MS };
