'use strict';
// The lab's population runner (lab/population.mjs): the pure pieces only.
// Nothing here starts a Claude Code session, a stub or a /vibe server: world
// validation, the vibe_send outcome classifier, the summary's send figures and
// the --human-cmd player (run against a tiny shell stub).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lab = () => import(path.join(ROOT, 'lab', 'population.mjs'));

const person = (name) => ({ name, role: 'engineer', says: `${name} work`, persona: 'plain' });
function world(days, extra = {}) {
  return {
    id: 'w-days', archetype: 'a week', relationship: 'established', open_line: false,
    people: { ada: person('Ada'), ben: person('Ben') },
    timeline: days.map((day, i) => ({ who: i % 2 ? 'ben' : 'ada', day, prompt: `day ${day}` })),
    ...extra,
  };
}

test('a five-day world is accepted, in day order', async () => {
  const { validateWorld } = await lab();
  assert.deepEqual(validateWorld(world([1, 1, 2, 3, 3, 4, 5])), []);
  assert.deepEqual(validateWorld(world([1, 7])), []);
});

test('day 8, day 0, a fractional day and a string day are rejected', async () => {
  const { validateWorld } = await lab();
  for (const bad of [8, 0, 2.5, '2']) {
    const errs = validateWorld(world([1, bad]));
    assert.ok(errs.some((e) => /timeline\[1\]\.day must be a whole number from 1 to 7/.test(e)), `${bad}: ${errs.join('\n')}`);
  }
});

test('a timeline out of day order is rejected (days are played in order)', async () => {
  const { validateWorld } = await lab();
  const errs = validateWorld(world([1, 3, 2]));
  assert.ok(errs.some((e) => /timeline\[2\]\.day is 2 after a day-3 entry/.test(e)), errs.join('\n'));
});
