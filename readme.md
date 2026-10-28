# chamoji

Changelogs from your git history. Chamoji reads [gitmoji](https://gitmoji.dev), [Conventional Commits](https://www.conventionalcommits.org) and plain messages like "Fix crash on startup". It groups them into Keep a Changelog sections and suggests the next semver version.

## Install

```bash
npm install --global @chamoji/cli
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
```

`next-version` exits with code 3 and prints nothing to stdout when no commit since the last tag implies a version bump (only docs, tests or refactors, say).

| Option                | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format`            | `markdown` (default), `md`, `json` or `html`                                                                                                            |
| `--output`, `-o`      | Write to a file instead of stdout                                                                                                                       |
| `--from <tag>`        | Leave out this release and everything older                                                                                                             |
| `--to <ref>`          | Ref to treat as the head of history (default `HEAD`)                                                                                                    |
| `--release <version>` | Name and date the unreleased section, e.g. when cutting a release. Its compare link targets the tag it will get (`v<version>` when your tags use a `v`) |
| `--config <file>`     | Config file (default `chamoji.config.json` when present)                                                                                                |
| `--ai`                | Sort the commits no rule can place with [Jev](https://typesafe.ai) (see below)                                                                          |

Typical release flow:

```bash
set -e
version=$(chamoji next-version)   # stops here when nothing needs releasing
chamoji changelog --release "$version" --output CHANGELOG.md
git commit -am "🔖 Release v$version"
git tag "v$version"
```

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
  - Messages about docs, typos, tests, CI, performance, security and refactoring each go to their own section.
  - Version-only commits (`1.2.1`, `Release 3.0.0`) are hidden.
  - "Require Node.js 20" counts as a breaking change.
  - Chamoji doesn't add emojis to plain messages, so they appear as written.
- **Dependency updates** (⬆️ ⬇️ 📌 ➕ ➖, `chore(deps):`, `fix(deps):` and Dependabot or Renovate subjects) are collapsed into a single line, such as `⬆️ 47 dependency updates: jest, vite, … and 12 more`. The JSON output keeps every commit.
- **Breaking changes** are 💥, a `!` after any type (`feat!:`, `deps!:`), or a `BREAKING CHANGE:` footer. They are listed under Breaking changes and give a major bump.
- **The next version** comes from each gitmoji's `semver` field (✨ minor, 🐛 patch, …).
- **Commit trailers** (`Key: value` lines at the end of a message) are parsed and included in the JSON output.

## Sorting the rest with AI (`--ai`)

Some messages are too vague for rules, such as "Accept camelCase flags" or "Tidelift tasks". `--ai` sends just those commits to [Jev](https://typesafe.ai), TypeSafe's fast classification model. It picks a gitmoji for each one. Picks below 60% confidence are dropped, and those commits stay in Miscellaneous.

```bash
export TYPESAFE_API_KEY=...   # from https://typesafe.ai
chamoji changelog --ai
```

- **What is sent:** only the commits no rule could sort, at most 300 characters each of subject and body, with email addresses and trailer lines such as `Signed-off-by:` removed. Never diffs, code or author details. `next-version --ai` sends only unreleased commits.
- **If a request fails:** chamoji stops sending, keeps the picks it already has, and leaves the rest in Miscellaneous.
- **What it never does:** override an emoji or type the author wrote, or mark a change as breaking. Only authors declare breaking changes.
- **Without `--ai`:** chamoji makes no network calls.

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
