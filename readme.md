<p align="center">
  <img src="https://raw.githubusercontent.com/HeavenlyEntity/chamoji-ai/main/docs/brand/chamoji-plate.png" alt="chamoji" width="560">
</p>

<p align="center">
  <a href="https://github.com/HeavenlyEntity/chamoji-ai/actions/workflows/ci.yml"><img src="https://github.com/HeavenlyEntity/chamoji-ai/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@chamoji/cli"><img src="https://img.shields.io/npm/v/@chamoji/cli?color=bbbff2&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@chamoji/cli"><img src="https://img.shields.io/node/v/@chamoji/cli?color=faadc3" alt="Node version"></a>
  <a href="https://github.com/HeavenlyEntity/chamoji-ai/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HeavenlyEntity/chamoji-ai?color=fbcfb3" alt="MIT license"></a>
</p>

<p align="center"><strong>Every commit explains itself.</strong></p>

<p align="center"><img src="docs/demo.gif" alt="chamoji sorting a plain, messy git log into changelog sections, then cutting the release" width="720"></p>

# chamoji

Changelogs from your git history, however your team writes commits:

- emoji commits in the [gitmoji](https://gitmoji.dev) convention (`✨ Add login`)
- [Conventional Commits](https://www.conventionalcommits.org) (`feat: add login`)
- plain messages (`Add login`)

Chamoji groups them into readable sections, collapses dependency noise into one line, can sort vague commits with AI, and suggests the next semver version. It's its own engine, not a wrapper around gitmoji tools; gitmoji is one of the commit styles it understands.

## Install

```bash
npm i -g @chamoji/cli
```

Or run it without installing: `npx @chamoji/cli changelog`.

Requires Node.js 22 or newer and git.

## Usage

```bash
chamoji changelog                          # Markdown to stdout
chamoji changelog --output CHANGELOG.md    # write a file
chamoji changelog --format html --output changelog.html
chamoji changelog --format json            # machine-readable
chamoji next-version                       # e.g. 1.3.0
chamoji release                            # cut a release (see below)
chamoji commit                             # write a commit (see below)
```

`next-version` exits with code 3 and prints nothing to stdout when no commit since the last tag implies a version bump (only docs, tests or refactors, say).

| Option                | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format`            | `markdown` (default), `md`, `json` or `html`                                                                                                            |
| `--output`, `-o`      | Write to a file instead of stdout                                                                                                                       |
| `--from <tag>`        | Leave out this release and everything older                                                                                                             |
| `--to <ref>`          | Ref to treat as the head of history (default `HEAD`)                                                                                                    |
| `--release <version>` | Name and date the unreleased section, e.g. when cutting a release. Its compare link targets the tag it will get (`v<version>` when your tags use a `v`) |
| `--since <ref>`       | Only the commits after this ref, as one Unreleased section, to preview a branch: `--since origin/main`                                                  |
| `--config <file>`     | Config file (default `chamoji.config.json` when present)                                                                                                |
| `--ai`                | Sort the commits no rule can place with [Jev](https://typesafe.ai) (see below)                                                                          |

## Writing commits

The changelog is only as good as the commits. The composer helps write commits that sort themselves.

```bash
chamoji commit           # compose a commit
chamoji commit -a        # and include every tracked change
chamoji hook install     # offer the composer on a plain `git commit`
chamoji hook uninstall
```

The composer asks for:

1. **A gitmoji,** from a search list. Type `bug`, `fix` or a few letters such as `spk`, and pick with the arrow keys.
2. **The scope**
3. **The title**
4. **A body**
5. **Why?** This is kept as a `Why:` trailer.
6. **Whether it breaks anything.** If it does, it adds a `BREAKING CHANGE:` trailer.

Enter moves on, Esc goes back and Ctrl-C cancels. It writes `✨ (auth): Add login`, or `:sparkles: (auth): Add login` with `emojiFormat: "code"`.

**The hook** opens the same composer when you run `git commit` with no message. It stays out of the way:

- It never runs for `git commit -m` or `-F`, merges, squashes, amends or rebases.
- It never runs when the message already has a gitmoji.
- It never runs in CI, or without a terminal, as with an editor's commit button.
- Ctrl-C keeps git's own message, so the hook never blocks a commit.

**Hook managers:**

- **husky:** `chamoji hook install` prints the line to add to `.husky/prepare-commit-msg`: `chamoji hook run "$@"`.
- **lefthook:** add this to `lefthook.yml`:

  ```yaml
  prepare-commit-msg:
    commands:
      chamoji:
        run: chamoji hook run {1} {2} {3}
        interactive: true
  ```

**Switching from gitmoji-cli:** run `chamoji hook install`. It replaces gitmoji-cli's hook, and leaves any other hook alone. Your settings carry over. chamoji reads `.gitmojirc.json`, or the `gitmoji` key in `package.json`, for these keys:

- `emojiFormat`
- `scopePrompt`
- `messagePrompt`
- `capitalizeTitle`
- `autoAdd`, which stages everything first

Without a config, chamoji writes the emoji character and asks for a scope.

### Suggestions from Jev

With your opt-in, the composer asks [Jev](https://typesafe.ai) about the staged changes as it opens. It takes about 100 ms, and the composer never waits more than 2 seconds for it.

```bash
git config --global chamoji.composer true   # or without --global, for one repository
git config --global chamoji.sendDiffs true  # optional: send the diff too
```

- **The gitmoji:** Jev's three likeliest gitmojis appear as a hint above the list. When it's very sure (90% or more), they move to the top instead, and the first is selected. Typing a search, or any key pressed before the answer arrives, keeps the list as it was.
- **Breaking:** when Jev thinks the change may break something (70% or more), the last step says so. The default is still No; only you declare a breaking change.
- **Split:** when the staged changes look like unrelated pieces of work, the title step suggests committing them separately.

**What is sent:** the staged files' paths, with each one's status and the lines added and deleted, and the message's first line when `git commit` already has one. With `chamoji.sendDiffs`, the staged diff goes too: at most 200 lines per file and 2,000 in all, with private keys and common token formats replaced by `<redacted>`.

**What is never sent:** secrets files and lockfiles, not even their names. That covers `.env*`, `.envrc`, `.npmrc`, `.netrc`, `credentials*`, `id_*` keys, `*.pem`, `*.key`, `*.p12`, `*.tfvars` and similar, any path containing "secret", and lockfiles. The request says only how many files were left out.

**The opt-in lives in git config,** not in a file in the repository, so a repository you clone can't switch it on for you. The key comes from `TYPESAFE_API_KEY`, or that line in an untracked `.env.local` or `.env`.

## Cutting a release

```bash
chamoji release --dry-run   # the version and notes it would release; changes nothing
chamoji release             # CHANGELOG.md, version bumps, release commit and tag
chamoji release 2.0.0-rc.1  # a version you choose, such as a prerelease
chamoji release --push      # also push the commit and tag, and create the GitHub release
```

It does, in order:

1. **Checks:** a clean working tree, origin's default branch (`--any-branch` to skip that check), and the full history. A shallow clone is unshallowed and tags are fetched first.
2. **Version:** the one `next-version` picks, or the one you give. The tag follows your tags' style, `v1.4.0` or `1.4.0`.
3. **CHANGELOG.md:** chamoji's section for the release goes above the last one, below any `Unreleased` section, and older entries are left exactly as they are. A repo without the file gets one written from the whole history.
4. **Version bumps:** every tracked `package.json`, `package-lock.json`, `pyproject.toml` or `Cargo.toml` that carries the previous version.
5. **Commit and tag:** a release commit in your repo's style (`🔖 Release v1.4.0`, `chore(release): 🔖 v1.4.0` or `Release v1.4.0`), which chamoji leaves out of later changelogs, and an annotated tag. If anything fails before the tag exists, the repo is reset to where it started.
6. **With `--push`:** it pushes `HEAD` and that one tag, then runs `gh release create` with the notes when the [GitHub CLI](https://cli.github.com) is installed. A failed push keeps the local release.

`--trailer "Key: value"` adds trailer lines to the release commit, `--json` prints the result for scripts, and `--ai` works as it does for `changelog`. Exit codes: 0 released, 3 nothing to release, 2 a check failed (the message says which), 1 anything else.

## GitHub Action

The Action does three jobs:

- **Release notes:** on every pushed tag, it writes that tag's notes to its GitHub Release.
- **PR preview:** on every pull request, it keeps one comment up to date with the changelog lines the PR adds and the version merging it would make.
- **Releases:** on request, it cuts the whole release with `chamoji release`.

```yaml
# .github/workflows/changelog.yml
name: changelog
on:
  pull_request:
  push:
    tags: ['v*']
permissions:
  contents: write # release notes
  pull-requests: write # the PR comment
jobs:
  chamoji:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # chamoji reads every commit and tag
      - uses: HeavenlyEntity/chamoji-ai@v0.5.0
```

To release at the press of a button, add a `workflow_dispatch` workflow with `with: {mode: release}`. It takes an optional `release-version`. It commits `CHANGELOG.md` and the version bumps, then pushes the tag and creates the GitHub Release. Other inputs:

- `ai: true` with `typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}` sorts vague commits.
- `chamoji-version` pins the CLI.

On PRs from forks the token can't comment, so the preview goes to the job summary instead.

## Release from your coding agent

The `chamoji-release` skill teaches Claude Code, Codex, Cursor and other coding agents to cut a release the way the flow above does. Ask for "a release" or "release notes", and the agent:

- picks the version from the commits
- writes the new `CHANGELOG.md` section, keeping a hand-written changelog intact
- bumps the manifest version
- makes the release commit and tag
- shows you the notes and asks before it pushes

It can also set up a GitHub Actions workflow, so releases and notes happen without anyone at a keyboard.

Install it into your project:

```bash
npx skills add HeavenlyEntity/chamoji-ai --skill chamoji-release
```

Or try it without installing anything: [open a Claude Code session with the release prompt filled in](https://claude.ai/code?prompt=Cut%20a%20release%20of%20this%20repo%20with%20chamoji.%20Follow%20the%20skill%20at%20https%3A%2F%2Fraw.githubusercontent.com%2FHeavenlyEntity%2Fchamoji-ai%2Fmain%2Fskills%2Fchamoji-release%2FSKILL.md%3A%20pick%20the%20version%20from%20the%20commits%2C%20update%20CHANGELOG.md%2C%20bump%20the%20version%2C%20then%20commit%20and%20tag.%20Show%20me%20the%20release%20notes%20and%20ask%20before%20you%20push.). Pick your repository there, then press send.

## How commits are read

- **Releases** are semver tags reachable from `--to` (`v1.2.0` or `1.2.0`, prereleases included), ordered by semver. Commits after the newest tag form the Unreleased section.
- **Merge commits** are skipped.
- **`git revert` commits** (`Revert "✨ Add login"`) are listed as ⏪ reverts, not by the emoji of the commit they undo.
- **The gitmoji** can be a character (`✨`, with or without the invisible U+FE0F variation selector) or a shortcode (`:sparkles:`). Chamoji uses the earliest one in the subject. The list comes from the official [`gitmojis`](https://www.npmjs.com/package/gitmojis) package.
- **These subject forms all work:**
  - `✨ Add login`
  - `✨ (auth): Add login`
  - `feat(auth): ✨ Add login`
  - `feat: Add login`. A Conventional type without an emoji maps to one: `feat`→✨, `fix`→🐛, `docs`→📝, and so on.
- **Plain messages** are sorted by their wording:
  - "Add …" goes to Added, "Fix …" to Fixed, "Remove …" to Removed, "Deprecate …" to Deprecated.
  - Messages about docs, tests, CI, performance, security and refactoring each go to their own section. Typo fixes count as documentation.
  - Version-only commits and release chores are hidden, such as `1.2.1`, `Release 3.0.0`, "Tagging the 3.7.1 release" and "Build 2.29.4". So are merge leftovers like "Merge commit…" and "Squashed commit of…".
- **Component and tag prefixes** are read through to the subject behind them:
  - `Core: Fix the ready handler` is a fix, with `Core` as its scope. When the rest says nothing, the subject is left as written, so prose like "Note: …" isn't touched.
  - `[bugfix]`, `[feature]`, `[tests]`, `[docs]` and similar tags pick the section on their own.
  - Other tags, such as `[locale]` or `[pkg]`, become the scope, and the subject behind them picks the section.
  - "Require Node.js 20" counts as a breaking change.
  - Chamoji doesn't add emojis to plain messages, so they appear as written.
- **CI and test commits** (👷 💚 ✅ 🧪, `ci:`, `test:`, "Fix CI") go under Maintenance, so internal work doesn't read as new features.
- **Dependency updates** (⬆️ ⬇️ 📌 ➕ ➖, `chore(deps):`, `fix(deps):` and Dependabot or Renovate subjects) are collapsed into a single line, such as `⬆️ 47 dependency updates: jest, vite, … and 12 more`. The JSON output keeps every commit.
- **Breaking changes** are 💥, a `!` after any type (`feat!:`, `deps!:`), or a `BREAKING CHANGE:` footer. They are listed under Breaking changes and give a major bump.
- **The next version** comes from each gitmoji's `semver` field (✨ minor, 🐛 patch, …).
- **Commit trailers** (`Key: value` lines at the end of a message) are parsed and included in the JSON output.

## Sorting the rest with AI (`--ai`)

Some messages are too vague for rules, such as "Accept camelCase flags" or "Tidelift tasks". `--ai` sends just those commits to [Jev](https://typesafe.ai), TypeSafe's fast classification model. It picks a gitmoji for each one. Picks below 60% confidence are dropped, and those commits stay in Miscellaneous.

```bash
export TYPESAFE_API_KEY=...   # from https://typesafe.ai, or put it in .env.local
chamoji changelog --ai
```

- **What is sent:** only the commits no rule could sort, at most 300 characters each of subject and body, with email addresses and trailer lines such as `Signed-off-by:` removed. Never diffs, code or author details. `next-version --ai` sends only unreleased commits.
- **If a request fails:** chamoji stops sending, keeps the picks it already has, and leaves the rest in Miscellaneous.
- **What it never does:** override an emoji or type the author wrote, or mark a change as breaking. Only authors declare breaking changes.
- **Where the key comes from:** the `TYPESAFE_API_KEY` environment variable, or else that one line from `.env.local` or `.env` in the current folder. No other variable in those files is read.
- **Asking once:** Jev's answers are kept in `.git/chamoji/cache.json`, keyed by commit, so the next run doesn't ask about those commits again. The file holds only each commit's pick and confidence.
- **Without `--ai`:** chamoji makes no network calls.

## Update notice

When a newer version is out, chamoji says so once, after your command finishes:

```
chamoji 0.5.0 is available (you have 0.4.0): npm i -g @chamoji/cli@latest
```

- **What it sends:** one request a day at most, to `registry.npmjs.org`, asking for the latest `@chamoji/cli` version. Nothing about you or your repo is sent.
- **It never slows a command down.** The check runs in the background, and its answer shows on a later run.
- **It never touches stdout,** so pipes, `--format json` and `$(chamoji next-version)` are unaffected.
- **It's off in CI, and whenever stderr isn't a terminal.** To turn it off yourself, use `--no-update-check`, `NO_UPDATE_NOTIFIER=1` or `CHAMOJI_NO_UPDATE_CHECK=1`.
- **The cache** lives in `~/.config/chamoji/update-check.json`, or under `$XDG_CONFIG_HOME` or `%APPDATA%`.

## Config

`chamoji.config.json`:

```json
{
	"repositoryUrl": "https://github.com/acme/widgets",
	"groups": [
		{"group": "added", "label": "Added", "emojis": ["sparkles", "tada"]},
		{"group": "fixed", "label": "Fixed", "emojis": ["bug", "ambulance"]},
		{
			"group": "useless",
			"label": "Useless",
			"emojis": ["bookmark"],
			"hidden": true
		},
		{"group": "misc", "label": "Miscellaneous", "emojis": []}
	]
}
```

- `repositoryUrl` defaults to the `origin` remote. It is used for commit, issue (`#12`) and compare links.
- `groups` replaces the default sections. Emojis are gitmoji codes without colons. Commits that match no group go to `misc` when that group exists. Hidden groups are left out of the output, and `"collapse": true` renders a group as one summary line, as the default Dependencies group does.
- A plain JSON array of groups, the older format, is also accepted.

## Development

```bash
pnpm install
pnpm test     # vitest
pnpm check    # build (type-check) + prettier
```

`packages/core` is the engine: git reading, parsing, grouping and rendering, with no UI. `packages/cli` is the `chamoji` command. See `docs/research/` for where the project is heading.

## License

MIT © AMWARE Technologies LLC. chamoji is a project of AMWARE Technologies LLC.
