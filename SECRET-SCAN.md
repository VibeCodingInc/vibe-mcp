# Secret scan — export diligence

Before this client was exported to the public source-of-record, its full tree was
scanned with `gitleaks`. The scan reported two findings; both are **confirmed false
positives** and are allowlisted in `.gitleaks.toml`.

| File | Line | What it is | Why it is not a secret |
|---|---|---|---|
| `protocol/index.js` | 56 | `idempotencyKey: 'handoff_abc123'` | A literal example inside a JSDoc comment block documenting the handoff payload shape. |
| `tools/_work-context.test.js` | 78 | `const input = 'Key: sk-1234567890abcdefghij1234567890'` | A fabricated, non-functional OpenAI-shaped key used as **input** to a test that proves the redaction helper redacts such strings. |

No real credential, token, or key material is present in this repository. The client is
zero-dependency and holds no secrets by design: identity is a per-user OAuth token stored
locally at `~/.vibe`, never in source.

Re-run the scan any time with:

```bash
gitleaks detect --source . --no-git --redact -v
```
