/**
 * Platform's composition-boundary vectors (contracts/composition-boundary/v0.1.json,
 * #392), consumed by canonical id — not copied. The package's digest and recipient
 * rule must agree with every vector that states a digest; the edited/sanitized
 * vectors must NOT match. Skips honestly when the platform checkout is not beside
 * this repo.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storedRecipientHandle } = require('../protocol/handle');

const FILE = path.resolve(__dirname, '..', '..', 'platform', 'contracts', 'composition-boundary', 'v0.1.json');
const digest = (to, body) => crypto.createHash('sha256').update(`${storedRecipientHandle(to)}\n${body}`, 'utf8').digest('hex');

test("Platform's composition-boundary vectors: our digest matches every stated one, and never a changed body", (t) => {
  if (!fs.existsSync(FILE)) { t.skip('platform checkout not beside this repo'); return; }
  const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(v.contract, 'composition-boundary');
  assert.match(v.version, /^0\.1\.\d+$/);
  assert.equal(v.digest.input, '<recipient>\\n<body>');
  const ids = v.vectors.map(x => x.id);
  for (const id of ['CB-001', 'CB-002', 'CB-003', 'CB-004', 'CB-005', 'CB-006', 'CB-007', 'CB-008']) assert.ok(ids.includes(id), `${id} present`);
  let checked = 0;
  for (const x of v.vectors) {
    if (x.digest_over && x.approved_sha256) {
      // the stated digest is over the STORED recipient — our rule must produce the same recipient and the same hex
      assert.equal(storedRecipientHandle(x.request.to), x.digest_over.recipient, `${x.id} recipient rule`);
      assert.equal(digest(x.request.to, x.digest_over.body), x.approved_sha256.toLowerCase(), `${x.id} digest`);
      checked++;
    }
    if (x.id === 'CB-003') {
      // edited after approval: the digest of the NEW body must not equal the approved one
      assert.notEqual(digest(x.request.to, x.request.body), x.approved_sha256.toLowerCase(), 'CB-003 edited body differs');
    }
  }
  assert.ok(checked >= 2, `${checked} digest vectors checked`);
  // reserved keys: the package never sends any of these (asserted on the wire in _approved-digest.integration.test.js)
  assert.deepEqual(v.reserved_payload_keys.sort(), ['alternatives', 'candidates', 'composition', 'context_sources', 'discarded', 'drafts', 'ranking', 'rankings', 'sources']);
});
