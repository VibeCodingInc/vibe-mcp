# Publishing to npm

`slashvibe-mcp` is published from this repository (the public source-of-record)
only. The generated mirror inside the private platform monorepo is never a
publication source.

## How it works

1. Land the release on `main` (version bumped in `package.json`; `npm version`
   keeps `server.json` and `version.json` in sync).
2. Tag the release commit `vX.Y.Z` and push the tag.
3. `.github/workflows/publish.yml` runs on the tag and, in order:
   - verifies the tag matches `package.json` version;
   - runs the artifact tests — `pack:check`, `test`, `test:pack`, `test:release`;
   - publishes to npm with provenance (`npm publish --provenance --access public`).

A failed check stops the release before it reaches npm.

## One-time setup

- Add an npm **Automation** token as the `NPM_TOKEN` repository secret
  (Settings → Secrets and variables → Actions). Automation tokens do not require
  an OTP in CI.

## Checking status

- **GitHub Actions tab** — the `Publish to npm` run for the tag.
- **npm** — `npm view slashvibe-mcp version`.
- **Registry manifest** — `server.json` in this repo matches the published version.

## Troubleshooting

### "npm ERR! code E401"
Token is invalid or expired. Create a new Automation token and update the secret.

### "npm ERR! code E403"
Token doesn't have publish permission. Create an **Automation** token, not read-only.

### Version already exists
That version is already on npm. Bump to a higher version and tag again.
