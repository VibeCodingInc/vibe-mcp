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
   - publishes to npm by trusted publishing, with provenance, under the
     holding dist-tag `next` (`npm publish --provenance --access public --tag next`,
     no stored token);
   - the `promote` job waits (up to 45 minutes) until npm actually serves that
     version's tarball and its bytes match the registry's digest, then moves
     `latest` to it (`npm dist-tag add slashvibe-mcp@X.Y.Z latest`);
   - the `verify` job checks `dist-tags.latest`, version parity with
     production, and installs the registry artifact.

A failed check stops the release before it reaches npm. `latest` is never
moved before the tarball downloads: npm has taken 10–25 minutes to serve a new
tarball, and `npx slashvibe-mcp@latest` failed in that window when publish
moved `latest` straight away. If the wait times out, the version stays on
`next`, `latest` is untouched, and the log prints the promote command to run by
hand. Rerunning the workflow is safe: an existing version is not republished
and an already-promoted version is left alone.

## One-time setup

Publishing uses npm **trusted publishing**: npm accepts a short-lived identity
that GitHub Actions issues to the workflow run (OIDC). There is no `NPM_TOKEN`
secret, so nothing to rotate or expire.

Done once, by an owner of the package on npmjs.com:

1. Sign in at https://www.npmjs.com and open
   https://www.npmjs.com/package/slashvibe-mcp/access (package → **Settings**).
2. Under **Trusted Publisher**, choose **GitHub Actions**.
3. Fill in exactly (case matters):
   - Organization or user: `VibeCodingInc`
   - Repository: `vibe-mcp`
   - Workflow filename: `publish.yml` (the filename only, no path)
   - Environment name: leave empty
4. Save (npm asks for the passkey / 2FA).
5. Still under **Trusted Publisher**, tick **Allow npm dist-tag** (off by
   default). Without it the `promote` job cannot move `latest`: npm says
   "Permission to publish or stage a package does not grant this access
   automatically" (https://docs.npmjs.com/trusted-publishers). The job also
   needs npm 11.21.0 or later and installs it.

After the first release has published this way:

6. On the same page, under **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**. Trusted publishing keeps working;
   stolen or forgotten tokens stop working.
7. Delete the old `NPM_TOKEN` repository secret (GitHub → Settings → Secrets
   and variables → Actions) and revoke any remaining automation tokens on
   npmjs.com (Access Tokens).

Requirements the workflow already meets: a GitHub-hosted runner,
`id-token: write` on the publish job, npm 11.5.1 or later for the publish step,
and a `repository.url` in `package.json` that points at this repository.

## Checking status

- **GitHub Actions tab** — the `Publish to npm` run for the tag.
- **npm** — `npm view slashvibe-mcp version`.
- **Registry manifest** — `server.json` in this repo matches the published version.

## Troubleshooting

### `E404` or `E401`/`ENEEDAUTH` on `npm publish`
npm did not accept the run's identity. Check, in order: the trusted publisher
on npmjs.com names `VibeCodingInc` / `vibe-mcp` / `publish.yml` exactly; the
workflow file has not been renamed or moved; the publish job still has
`id-token: write`; the "Verify npm supports trusted publishing" step printed
npm 11.5.1 or later. (A 404 here means "not authorised", not "package missing".)

### `E422` provenance / repository mismatch
`repository.url` in `package.json` must be this repository.

### Publishing by hand
If the workflow cannot publish, an owner can run `npm publish` from a clean
checkout of the tag in their own terminal (passkey 2FA needs a real terminal).
A hand-published version carries no provenance attestation.

### `promote` failed or timed out
The version is published under `next`; `latest` did not move. Check that the
tarball downloads (`curl -sI https://registry.npmjs.org/slashvibe-mcp/-/slashvibe-mcp-X.Y.Z.tgz`),
then rerun the failed jobs, or an owner runs
`npm dist-tag add slashvibe-mcp@X.Y.Z latest`. An `E403`/`E401` on the
dist-tag step means **Allow npm dist-tag** is not enabled on the trusted publisher.

### Version already exists
On a rerun of the same tag this is expected: the publish step skips and the
promote job continues. For a new release, bump to a higher version and tag again.
