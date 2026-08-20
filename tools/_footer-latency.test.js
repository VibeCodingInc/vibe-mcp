const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveFooter, MINIMAL_FOOTER } = require('../footer');

test('a minimal footer never starts ambient network work', async () => {
  let ambientCalls = 0;
  const footer = await resolveFooter({ footer: 'minimal' }, async () => {
    ambientCalls += 1;
    return new Promise(() => {});
  });

  assert.equal(ambientCalls, 0);
  assert.equal(footer, MINIMAL_FOOTER);
  assert.match(footer, /vibe$/);
  assert.doesNotMatch(footer, /\b0\b/, 'unknown counts must be omitted, not rendered as zero');
});

test('ordinary results still load the ambient footer', async () => {
  let ambientCalls = 0;
  const footer = await resolveFooter({}, async () => {
    ambientCalls += 1;
    return '\nambient';
  });

  assert.equal(ambientCalls, 1);
  assert.equal(footer, '\nambient');
});
