---
name: chamoji-release
description: Cut a release from git history in one command with the chamoji CLI. It picks the semver bump from the commits, adds the CHANGELOG.md section, bumps manifest versions, and makes the release commit and tag (and pushes plus a GitHub release on request). Use it whenever the user wants to ship, cut, tag or publish a release, bump the version, write release notes or a changelog, asks "what changed since the last release", or wants changelogs automated in CI, even if they never mention chamoji. Works with gitmoji, Conventional Commits and plain commit messages.
---

# Releasing with chamoji

`scripts/release.mjs` (next to this file) does the whole release, so don't write or edit changelog entries yourself. chamoji writes them from the commits. The script:

- checks the tree is clean, the branch is the default one, and it has the full history and tags
- picks the version with `chamoji next-version`
- adds chamoji's section above the last release in `CHANGELOG.md`, leaving older entries untouched, or creates the file
- bumps `package.json`, `package-lock.json`, `pyproject.toml` and `Cargo.toml` files that carry the old version
- commits in the repo's own style, with a subject chamoji hides from future changelogs
- makes an annotated tag using the repo's tag prefix
- rolls back if anything fails before the tag exists

It needs Node 22+ and git. It runs `chamoji` if installed, else `npx @chamoji/cli`.

```bash
node <this-skill-dir>/scripts/release.mjs [flags]
```

If you only have this file (read from a URL), fetch the script first from `https://raw.githubusercontent.com/HeavenlyEntity/chamoji-ai/main/skills/chamoji-release/scripts/release.mjs`.

Flags:

- `--dry-run`: The user asks what would ship, or "what changed since the last release". Prints the version and notes and changes nothing.
- `--version 2.1.0`: The user names a version, or for a first release (no tags yet), or a prerelease such as `2.1.0-rc.1`
- `--push`: The user explicitly asks you to push, publish or create the GitHub release. It pushes HEAD and the tag only, then runs `gh release create` if `gh` is installed.
- `--ai`: The notes show a large Miscellaneous section and `TYPESAFE_API_KEY` is set. chamoji then sorts the vague commits.
- `--any-branch`: The user confirms releasing from a branch other than the default

**Pushing:** a pushed tag is hard to take back. Pass `--push` only for an explicit "push it", "publish" or "create the GitHub release". "Do the release" or "the works" is not enough; finish without it and offer to push.

## Reading the result

- **Exit 0:** the release is made. Relay the script's report as it is: the version and bump, the files changed, the commit, the tag, whether it pushed, and the notes. Don't re-run git commands to double-check it.
- **Exit 3:** nothing to release. Only docs, tests or refactors have landed since the last tag. Pass on the unreleased commits it lists, and offer `--version` if the user wants a patch anyway.
- **Exit 2:** a preflight check failed. The message says which: a dirty tree, the wrong branch, a first release that needs `--version`, or a shallow clone it couldn't unshallow. Fix it or ask the user, then run again.
- **Exit 1:** anything else. It says whether it rolled back, or, when only the push failed, that the local release was kept.

## Afterwards

- **Package publish:** if the repo publishes from CI when a tag is pushed (check `.github/workflows`), the tag is enough. Otherwise tell the user the publish command. Don't run it unasked.
- **Commit style:** the next changelog is only as good as the commits. When you commit in this repo, follow its style, describe what the user sees, and mark breaking changes with `!`, 💥 or a `BREAKING CHANGE:` footer.
- **Automating it:** to have releases or release notes happen in CI with no one at a keyboard, read `references/ci.md`.
