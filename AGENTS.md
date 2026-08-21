# Repository Agent Notes

- Keep `README.md` concise, English-only, and focused on project overview, setup, architecture summary, and short widget descriptions.
- Put detailed feature and widget documentation under `docs/`, then link to it from `README.md`.
- Keep repository-specific agent notes short and high-signal.

## Release checklist

- For a release, bump `package.json` and `package-lock.json`, then run `node --check src\renderer\app.js`, `npm test`, and `npm run build`.
- Build the changelog from commits since the previous release tag and publish it only in the GitHub Release notes; do not add release changelog files to the repository.
- Before publishing, inspect `dist\latest.yml`; the `path` and `files[].url` names must exactly match the GitHub Release asset names.
- Upload the hyphenated NSIS assets from `latest.yml`, e.g. `IS-VOL-Setup-X.Y.Z.exe` and `.blockmap`; do not upload renamed dotted assets.
- If `gh` fails oddly, clear process proxy/token env vars first: `GH_TOKEN`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `GIT_HTTP_PROXY`, `GIT_HTTPS_PROXY`.
- After publishing, verify with `gh release view vX.Y.Z --json assets` and confirm `latest.yml`, installer, and blockmap are present with matching names.
- Publishing a GitHub Release triggers `.github/workflows/macos-release.yml`, which builds and uploads x64 and arm64 DMG/ZIP assets plus a combined `latest-mac.yml`.
- To backfill an existing release, run the **Build macOS release** workflow manually with its `vX.Y.Z` tag.
