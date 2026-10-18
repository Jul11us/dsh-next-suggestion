# Publishing

GitHub and its versioned release archive are the distribution path for this version. Uploading source to GitHub does not publish the package to npm.

## Verify the source

Run from the repository root:

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
git diff --check

# inspect the replay prompt without provider spend
node scripts/eval-replay.mjs --dry-run
```

Review the `package.json` allowlist. Include host/client modules, locale metadata, bundle patch, icon, bilingual README, public documentation and illustrations, and license. Exclude credentials, DSH profiles, `node_modules`, tests, and private captures. The original local `docs/dock.png` capture is excluded from Git and npm.

Replay cases exported from real sessions contain private conversation text. All JSON files in `scripts/golden/` are ignored except the fictional `cases.json`; keep exports and recorded responses in that directory. Exports saved elsewhere require their own exclusion and must not be committed.

## GitHub Release

1. Update version and lockfile. Keep the README `releases/latest` link in sync.
2. Complete checks, commit, and push to `main`.
3. Confirm GitHub Actions passes for that exact commit.
4. Tag the verified commit with the version.
5. Create the archive:

```sh
node -e "require('node:fs').mkdirSync('dist',{recursive:true})"
npm pack --pack-destination dist
```

6. Create the GitHub Release and attach the generated `.tgz`.
7. Check public access and compare the downloaded asset's SHA-256 with the local archive.

Supply the asset URL to a compatible DSH installer, or extract the archive and install its inner `package` directory locally. Use the asset URL, not the release HTML page.

## Optional npm publication

This is a separate maintainer action. Check name availability and registry state first:

```sh
npm login
npm whoami
npm view dsh-next-suggestion version
npm pack --dry-run
npm publish --access public
npm view dsh-next-suggestion version dist.tarball
```

Only add npm installation instructions after verifying publication.

## Compatibility and renaming

Declared DSH range: `>=0.2.1-rc.2 <0.3.0`. Original development baseline: `0.2.1-rc.2`. Recheck public extension points before broadening compatibility claims.

If renamed or scoped, update package name, bundle row, module-loader id, config slot key, README URLs, and installer examples together.
