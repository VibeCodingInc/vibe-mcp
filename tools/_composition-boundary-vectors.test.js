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
      // the stated digest is over the STORED recipient — our rule must produce the same recipient
      assert.equal(storedRecipientHandle(x.request.to), x.digest_over.recipient, `${x.id} recipient rule`);
      if (/^[0-9a-f]{64}$/i.test(x.approved_sha256)) {
        assert.equal(digest(x.request.to, x.digest_over.body), x.approved_sha256.toLowerCase(), `${x.id} digest`);
      } else {
        // A placeholder ("<sha256 of …>") states the rule, not the hex: the digest is over the
        // body the server STORES (digest_over.body — trimmed / sanitized), so a digest over the
        // raw request text must differ whenever the server would normalize it. The package
        // hashes the trimmed text it sends; server-side sanitization beyond trimming is
        // refused with server_text and re-previewed (a definite refusal in dm.js).
        if (x.request.body !== x.digest_over.body) assert.notEqual(digest(x.request.to, x.request.body), digest(x.request.to, x.digest_over.body), `${x.id}: the raw text would be refused`);
        if (String(x.request.body).trim() === x.digest_over.body) assert.equal(digest(x.request.to, String(x.request.body).trim()), digest(x.request.to, x.digest_over.body), `${x.id}: trimming alone matches what the server stores`);
      }
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
