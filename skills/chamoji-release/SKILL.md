---
name: chamoji-release
description: Cut a release from git history with the chamoji CLI. It picks the semver bump from the commits, writes the new CHANGELOG.md section, bumps manifest versions, and makes the release commit, tag and GitHub release notes. Use it whenever the user wants to ship, cut, tag or publish a release, bump the version, write release notes or a changelog, asks "what changed since the last release", or wants changelogs automated in CI, even if they never mention chamoji. Works with gitmoji, Conventional Commits and plain commit messages.
---

# Releasing with chamoji

Release day usually goes wrong in the same few ways. Notes get written from memory, so half the shipped work is missing. The major/minor/patch call is a guess. Dependabot bumps bury the real features. `CHANGELOG.md`, the manifest version and the tag drift apart. chamoji works all of this out from the commits themselves, so your job is to run it in the right order, check what it says, and leave the repo in a state the developer can push with confidence.

Run the CLI with `npx --yes @chamoji/cli@latest <command>` (needs Node 22+ and git), or `chamoji <command>` if it is already installed. It reads `chamoji.config.json` from the repo root when there is one.

## 1. Preflight

Check these before changing anything:

- **Clean tree:** `git status --porcelain` is empty. A release commit should hold only release changes. If the tree is dirty, tell the developer and ask whether to commit or stash first.
- **Release branch:** usually the default branch, which `git symbolic-ref --short refs/remotes/origin/HEAD` names. Releasing from a feature branch tags commits that main never sees, so confirm before doing it.
- **Full history and tags:** CI runners and cloud sandboxes often clone shallowly. Then chamoji sees no tags and treats the whole history as unreleased. If `git rev-parse --is-shallow-repository` says `true`, run `git fetch --unshallow --tags`. Otherwise run `git fetch --tags` when there is a remote.
- **Tag style:** `git tag --list --sort=-v:refname | head` shows whether tags use a `v` prefix. Use the same style.
- **No semver tags yet:** this is the first release. Ask which version to start at, and suggest the version already in the manifest, or `0.1.0`.

## 2. Pick the version

- **The developer named a version:** use it, after checking that it is valid semver and newer than the last tag.
- **Otherwise:** run `chamoji next-version`.
  - It prints the version, chosen from the gitmoji or commit type (breaking → major, feature → minor, fix → patch).
  - **Exit code 3** means nothing since the last tag needs a release (only docs, tests, refactors and so on). Say so, show what is unreleased (step 3), and stop unless the developer still wants a patch.
- **Prereleases** (`beta`, `rc`): take the version `next-version` gives, add `-rc.N`, and continue N from any existing tags for that version.

## 3. Preview the notes

Render only the new section. Pass the tag name, not the bare version: `--release` uses it verbatim as the heading.

```bash
chamoji changelog --from <last-tag> --release <tag>   # e.g. --from v1.3.2 --release v1.4.0
```

(For a first release, leave out `--from`.)

Read it before writing anything:

- **Breaking changes section:** make sure it agrees with the bump. A major bump with nothing under it, or breaking entries under a minor bump, means the version or a commit is wrong. Raise it rather than ship it.
- **Large Miscellaneous section:** these are vague commits no rule could sort. If `TYPESAFE_API_KEY` is set (in the environment, `.env.local` or `.env`), rerun with `--ai` and chamoji's classifier sorts them. Otherwise mention the option. Never rewrite published history to tidy the notes.
- **Show the developer the section:** these are their notes, so let them see them.

## 4. Write CHANGELOG.md

Don't destroy a curated changelog. First check who owns the file. Compare it with what chamoji renders as of the last tag:

```bash
chamoji changelog --to <last-tag> | diff - CHANGELOG.md
```

- **No `CHANGELOG.md`, or the only differences are release-heading dates or whitespace:** chamoji owns the file. Regenerate it with `chamoji changelog --release <tag> --output CHANGELOG.md`. The output comes straight from history, so the file can't drift from the tags.
- **Real differences, such as prose, hand-picked entries or another tool's format:** someone curates it. Keep their entries word for word, and add the new release above the first `## ` release heading, written the way theirs are. chamoji's grouping tells you what shipped, and their file tells you how to say it:
  - copy their heading format (`## [2.0.2] - 2026-10-28`, not chamoji's compare link)
  - copy their section names
  - match their entry style: if their entries are plain sentences with no emoji, hashes or links, rewrite each entry that way
  - leave out what they leave out, such as docs-only or changelog-update commits when their older releases never list them

  Show the developer what you wrote, since you put it in your own words.

## 5. Bump manifest versions

Update every file that carries the previous release's version, and leave the rest alone:

- **`package.json`:** `npm version <version> --no-git-tag-version`. In a monorepo, run it in each published package. pnpm and yarn workspaces work the same way.
- **`pyproject.toml`, `Cargo.toml`, `*.gemspec`, `version.go` and similar:** edit the version field.
- **Lockfiles:** refresh them if the bump changes them, for example `cargo update -p <crate>`, or `npm install --package-lock-only`.

## 6. Commit and tag

Match the repo's commit style, and use a subject chamoji hides from future changelogs:

| Repo style           | Release commit              |
| -------------------- | --------------------------- |
| gitmoji              | `🔖 Release v1.4.0`         |
| Conventional Commits | `chore(release): 🔖 v1.4.0` |
| plain                | `Release v1.4.0`            |

```bash
git add CHANGELOG.md <manifests>
git commit -m "🔖 Release v1.4.0"
git tag -a v1.4.0 -m "v1.4.0"
```

The tag goes on the release commit, so the changelog inside the tagged tree already lists that release.

## 7. Ship

Pushing and publishing reach other people, and a pushed tag is hard to take back. So stop after step 6 unless the developer explicitly asked you to push or publish: "push it", "publish to npm", "create the GitHub release". "Do the release", "cut a release" and "the works" are not enough. In that case, list the commands below in your report and offer to run them. When they did ask:

- **Push:** `git push origin HEAD v1.4.0`. Push the tag by name, not `--tags`, which pushes every local tag.
- **GitHub release:** save the step 3 section (without the `# Changelog` heading) to a file, then run `gh release create v1.4.0 --title v1.4.0 --notes-file notes.md`. Add `--prerelease` for `-rc`/`-beta` versions.
- **Package publish:** many repos publish from CI when a tag is pushed. Check `.github/workflows` before you run `npm publish` or the like yourself.

## 8. Report

Finish with:

- the version and why: "minor: 3 features, 2 fixes, no breaking changes"
- the notes section
- the files changed
- the commit and tag
- what is still left, for example "not pushed" or "CI will publish on the tag"

## Keeping the next release clean

chamoji is only as good as the commit subjects. When you commit in this repo:

- follow its existing style
- describe the change the user sees ("Add CSV export", not "update utils")
- mark breaking changes explicitly, with `!` after the type, 💥, or a `BREAKING CHANGE:` footer

That keeps the next `next-version` honest.

## Changelogs on autopilot

When the developer wants releases to happen without anyone at a keyboard, read `references/ci.md`. It has a GitHub Actions workflow that runs this same flow on a button press, or on every push to main, and a lighter one that only writes release notes when a tag is pushed.
