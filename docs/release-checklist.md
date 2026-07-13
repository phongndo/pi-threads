# Release checklist

Use this lightweight checklist for npm releases. It is intentionally docs/config
focused so it can be updated without colliding with feature or source refactors.

## 1. Confirm compatibility

- [ ] `docs/compatibility.md`, `README.md`, `CONTRIBUTING.md`, `package.json`,
      and `.github/workflows/ci.yml` agree on the supported Node, Pi, and pnpm
      versions.
- [ ] Any Node, pnpm, or Pi minimum-version change is called out in the changelog
      and release notes.
- [ ] Wildcard Pi peer dependencies remain intentional; runtime Pi packages
      should be supplied by Pi, not bundled by this extension.

## 2. Local quality gate

Run from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm licenses:list
pnpm pack --dry-run
```

Before publishing, inspect the dry-run package contents. The tarball should
include the extension source, release docs, README, changelog, license, and
project health files, and should not include `node_modules`, coverage output,
logs, secrets, or local temp files.

## 3. CI gate

- [ ] GitHub Actions CI is green for the release commit.
- [ ] CI completed format, lint, typecheck, tests, and `pnpm pack --dry-run`.
- [ ] Any release workflow uses the same Node and pnpm versions documented in
      [`compatibility.md`](compatibility.md).

## 4. Version and tag

- [ ] Choose the SemVer bump. While the package is pre-1.0, prefer patch bumps
      for fixes/docs and minor bumps for user-visible behavior or API changes.
- [ ] Update `package.json` and `CHANGELOG.md` for the release.
- [ ] Commit the release changes and tag the exact commit as `vX.Y.Z`.

## 5. npm provenance checklist

For normal releases, publish from GitHub Actions or another npm-supported CI
provenance environment rather than from a local workstation.

- [ ] npm trusted publishing or an appropriate npm automation token is configured
      for `@phongndo/pi-dispatch`.
- [ ] The publish job has least-privilege permissions, including `contents: read`
      and `id-token: write` for provenance.
- [ ] The publish job reruns the local quality gate before publishing.
- [ ] Publish with provenance, for example:

      ```bash
      pnpm publish --access public --provenance
      ```

- [ ] Verify the npm package page shows provenance for the new version.
- [ ] Verify the dist tag, repository link, tarball contents, and package version
      match the release commit.

If an emergency local publish is required, document why provenance is absent in
the release notes and follow up with a provenance-backed release as soon as
practical.

## 6. E2E smoke-test outline

Run this once against the local checkout or packed candidate, then again against
the published npm version.

1. Start Pi with the extension loaded locally:

   ```bash
   pnpm dev:pi
   ```

   After publishing, repeat with the npm package:

   ```bash
   pi -e npm:@phongndo/pi-dispatch@<version>
   ```

2. In Pi, ask for a small background thread that reports its working directory
   and returns `done`. Verify `start`, `wait` or `poll`, and `list` succeed.
3. Start a second thread with an explicit existing `cwd` and a safe narrowing
   argument such as `--no-tools`; verify it cannot loosen parent restrictions.
4. Stop a live thread and verify the final snapshot reports it as stopped or
   closed.
5. Archive a completed thread, then list archived/all visibility and verify the
   thread remains discoverable.
6. Open `/threads`; verify the browser loads, filtering works, and poll/refresh
   controls do not start new work.
7. Exit the parent Pi session and verify no child Pi processes remain running.
