---
name: is-vol-github-release
description: Prepare an IS-VOL GitHub release when the user provides a target version, including version bump, changelog from the latest GitHub release, Windows artifacts, draft release, and verification.
metadata:
  display_name: IS-VOL GitHub Release
---

# IS-VOL GitHub Release

Use this skill in the `indepstate-vol` repository when the user asks to prepare an IS-VOL GitHub release and provides a target version such as `1.8.1`. The skill expects the version number from the user; do not invent it.

## Scope

Prepare the release the same way this repository's recent releases were prepared:

- find the latest GitHub release/tag and build release notes from that release to current `HEAD`
- bump `package.json` and `package-lock.json`
- run the release checklist
- build Windows artifacts
- commit only the version bump, tag, push, create a GitHub draft release, upload assets, and verify the result

Do not add changelog files to the repository. Release notes may be written to a temporary file for `gh release create`.

## Permissions

Creating or updating a GitHub release uploads local artifacts externally. If the user has not explicitly authorized uploading artifacts to GitHub in the current request, stop after building and pushing the tag, then ask for that authorization in one short sentence. If the user explicitly confirms in the request, proceed with GitHub draft release creation and upload.

Use normal sandbox escalation for commands that need network access, Git metadata writes, GitHub CLI config/token access, or Electron cache access.

## Workflow

1. Verify repository state and release baseline.
   - Run `git status --short --branch`.
   - Run `gh release list --repo iziziz-indepstate/indepstate-vol --limit 10` and identify the latest release tag.
   - Run `git fetch origin --tags`.
   - Run `git log --reverse --pretty=format:%h%x09%s <latest-tag>..HEAD`.
   - Run `git diff --stat <latest-tag>..HEAD`.
   - Treat unrelated existing untracked `.codex/` content as user-owned; do not delete or stage it.

2. Bump the version.
   - Update only the top-level `"version"` in `package.json`.
   - Update the root `"version"` and `packages[""].version` in `package-lock.json`.
   - Prefer a scoped patch or a package manager command that does not create a tag.

3. Run checks.
   - Run `node --check src\renderer\app.js`.
   - Run `node --test`.
   - If `npm` or `node` is not on `PATH`, use `load_workspace_dependencies` or the bundled Codex runtime Node executable.
   - Existing `MODULE_TYPELESS_PACKAGE_JSON` warnings are not failures when all tests pass.

4. Build release artifacts.
   - Run the Windows build equivalent to `npm run build` / `electron-builder --win`.
   - Electron Builder may need access to the Electron cache under `AppData`.
   - After the build, inspect `dist\latest.yml`.
   - `latest.yml` must point to hyphenated asset names such as `IS-VOL-Setup-X.Y.Z.exe`.
   - If Electron Builder produced `IS-VOL Setup X.Y.Z.exe` and `.blockmap`, copy them to matching hyphenated filenames before upload.

5. Commit, tag, and push.
   - Stage only `package.json` and `package-lock.json`.
   - Commit as `Bump version to X.Y.Z`.
   - Create tag `vX.Y.Z`.
   - Push `main` and `vX.Y.Z` to `origin`.

6. Create a GitHub draft release when artifact upload is authorized.
   - Create concise release notes from `<latest-tag>..HEAD`; group by user-facing changes, fixes, data/runtime changes, docs/tests as appropriate.
   - Use `gh release create vX.Y.Z --repo iziziz-indepstate/indepstate-vol --draft --title "IS-VOL X.Y.Z" --notes-file <temp-notes> dist\latest.yml dist\IS-VOL-Setup-X.Y.Z.exe dist\IS-VOL-Setup-X.Y.Z.exe.blockmap`.
   - GitHub may return an `untagged-...` URL for draft releases; that is acceptable only after verification.

7. Verify and report.
   - Run `gh release view vX.Y.Z --repo iziziz-indepstate/indepstate-vol --json tagName,name,isDraft,isPrerelease,url,assets`.
   - Confirm `tagName` is `vX.Y.Z`, `isDraft` is `true`, and these assets are `uploaded`: `latest.yml`, `IS-VOL-Setup-X.Y.Z.exe`, `IS-VOL-Setup-X.Y.Z.exe.blockmap`.
   - Re-check `git status --short --branch`, `git log -1 --oneline --decorate`, and `dist\latest.yml`.
   - Final response should include the draft release link, checks run, pushed commit/tag, uploaded assets, and mention any remaining unrelated untracked `.codex/` content.

## Changelog Style

Keep release notes concise and factual. Use English headings. Example shape:

```markdown
## Changes since X.Y.Z

### Features
- ...

### Fixes
- ...

### Tests
- ...
```

For patch releases with a single fix, use only the relevant headings.
