# chamoji

Changelogs from your git history. Chamoji reads [gitmoji](https://gitmoji.dev) and [Conventional Commits](https://www.conventionalcommits.org) messages, groups them into Keep a Changelog sections, and suggests the next semver version.

## Install

```bash
npm install --global chamoji-ai
```

Requires Node.js 22 or newer and git.

## Usage

```bash
chamoji changelog                          # Markdown to stdout
chamoji changelog --output CHANGELOG.md    # write a file
chamoji changelog --format html --output changelog.html
chamoji changelog --format json            # machine-readable
chamoji next-version                       # e.g. 1.3.0, or "none"
```

| Option | Meaning |
| --- | --- |
| `--format` | `markdown` (default), `md`, `json` or `html` |
| `--output`, `-o` | Write to a file instead of stdout |
| `--from <tag>` | Leave out this release and everything older |
| `--to <ref>` | Ref to treat as the head of history (default `HEAD`) |
| `--release <version>` | Name and date the unreleased section, e.g. when cutting a release |
| `--config <file>` | Config file (default `chamoji.config.json` when present) |

Typical release flow:

```bash
version=$(chamoji next-version)
chamoji changelog --release "$version" --output CHANGELOG.md
git commit -am "🔖 Release v$version" && git tag "v$version"
```

## How commits are read

- **Releases** are semver tags reachable from `--to` (`v1.2.0` or `1.2.0`, prereleases included), ordered by semver. Commits after the newest tag form the Unreleased section.
- **Merge commits** are skipped.
- **The gitmoji** can be a character (`✨`, with or without the invisible U+FE0F variation selector) or a shortcode (`:sparkles:`). Chamoji uses the earliest one in the subject. The list comes from the official [`gitmojis`](https://www.npmjs.com/package/gitmojis) package.
- **These subject forms all work:**
  - `✨ Add login`
  - `✨ (auth): Add login`
  - `feat(auth): ✨ Add login`
  - `feat: Add login`. A Conventional type without an emoji maps to one: `feat`→✨, `fix`→🐛, `docs`→📝, and so on.
- **Breaking changes** are 💥, a `!` after the type (`feat!:`), or a `BREAKING CHANGE:` footer. They are listed under Breaking changes and give a major bump.
- **The next version** comes from each gitmoji's `semver` field (✨ minor, 🐛 patch, …).
- **Commit trailers** (`Key: value` lines at the end of a message) are parsed and included in the JSON output.

## Config

`chamoji.config.json`:

```json
{
	"repositoryUrl": "https://github.com/acme/widgets",
	"groups": [
		{"group": "added", "label": "Added", "emojis": ["sparkles", "tada"]},
		{"group": "fixed", "label": "Fixed", "emojis": ["bug", "ambulance"]},
		{"group": "useless", "label": "Useless", "emojis": ["bookmark"], "hidden": true},
		{"group": "misc", "label": "Miscellaneous", "emojis": []}
	]
}
```

- `repositoryUrl` defaults to the `origin` remote. It is used for commit, issue (`#12`) and compare links.
- `groups` replaces the default sections. Emojis are gitmoji codes without colons. Commits that match no group go to `misc` when that group exists. Hidden groups are left out of the output.
- A plain JSON array of groups, the older format, is also accepted.

## Development

```bash
pnpm install
pnpm test     # vitest
pnpm check    # build (type-check) + prettier
```

`packages/core` is the engine: git reading, parsing, grouping and rendering, with no UI. `packages/cli` is the `chamoji` command. See `docs/research/` for where the project is heading.
