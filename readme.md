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
chamoji ws                                 # list workstreams (see below)
chamoji why src/auth.ts:42                 # why is this line here? (see Project memory)
```

A bare `chamoji` draws the wordmark and a short help to stdout, and exits 0. `chamoji --help` lists every option. An unknown command prints a short message to stderr and exits 2.

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

## Workstreams

A workstream is a piece of work that takes more than one commit, such as "Auth revamp". Mark its commits, and the changelog shows it as one Highlight with those commits folded underneath, instead of a flat list.

```bash
chamoji hook install               # once: the hook is what stamps commits
chamoji ws start "Auth revamp" 🔐  # a new workstream, now active here
git commit -m "✨ Add login"       # gets the line "Workstream: auth-revamp"
chamoji ws                         # workstreams and their unreleased commits (* is active)
chamoji ws switch <slug>           # make another one active (--none clears it)
chamoji ws ship                    # mark the active one shipped (or: chamoji ws drop)
```

`ws start`, `ws ship` and `ws drop` stage `.chamoji/workstreams.yml` and don't commit it. Your next commit records the change.

`ws start` and `ws switch` tell you if `git commit` won't stamp your commits, which is the case in a fresh clone until you run `chamoji hook install`, because git doesn't clone hooks. They read the hook git would run, including one set up through husky or lefthook, and never install one for you. If another tool's hook doesn't show whether it runs chamoji, they say so. `chamoji hook install` shows the line to add.

- **Committed or local:** `.chamoji/workstreams.yml` is committed, so the team shares each workstream's title, emoji, description, status and links. Which workstream is active is local: `.git/chamoji/active`, one per worktree.
- **What gets stamped:** commits made with `git commit -m` (an amend with `-m` too, since the hook can't tell them apart), `chamoji commit`, and messages written by the composer. Merges, squashes, amends without `-m`, rebases, cherry-picks and reverts are left alone. A `-m` subject starting `Revert "` or `Reapply "` isn't stamped either, because a clean `git revert` looks the same to the hook.
- **Editor commits aren't stamped.** The hook runs before the editor opens, and stamping an empty message would stop git from aborting when you quit. So for a plain `git commit` whose message you write in the editor, the hook prints a notice naming the workstream. Add the `Workstream:` line yourself, or use `-m` or `chamoji commit`. A message written in the editor from a `commit.template` works the same way.
- **When it becomes a Highlight:** once the workstream is `shipped` in the file as of that release. Earlier releases don't change, and a workstream's commits in an earlier release stay loose. Commits of a workstream that is still active or dropped are listed as usual, and breaking commits stay under Breaking changes. The changelog reads the committed file, so commit the ship before previewing the changelog.
- **Squash merges:** chamoji reads `Workstream:` lines anywhere in a commit's body. A squash that mixes workstreams gets the first one found. On GitHub, the line survives with the "Default message" and "Pull request title and commit details" settings. "Pull request title and description" and "Pull request title" drop it, so those commits land outside their Highlight. With "title and description", add the `Workstream:` line to the PR description. With "title" alone, add it in the merge box.

## Project memory

Git keeps what changed. Project memory keeps why: the reasoning behind a commit, still there after the branch is deleted, and one command away for you or your AI agent. It is built from three things, all in git: intent cards in commit messages, workstream summaries on their own ref, and a search index you can rebuild at any time.

### Intent cards

An intent card is up to four lines in a commit message. The keys are matched ignoring case:

- `Why:` the reason for the change
- `Constraint:` a limit the change had to live within
- `Gotcha:` something that will trip up the next person
- `Follow-up:` work this change leaves for later

Write them at the end of the message, use the composer's **Why?** field, or add them from the command line with git's own flag:

```bash
git commit -m "✨ Retry idle connections" \
  --trailer "Why: the API drops idle connections after 30 seconds" \
  --trailer "Gotcha: the retry must not repeat a POST"
```

A line can run on over the lines that follow it, until a blank line or the next `Key: value` line, and a key can repeat. Jev never writes or changes a card.

**Squash merges:** chamoji reads card lines anywhere in a commit's body, so a squash keeps them as long as the body survives. On GitHub that is the same table as for `Workstream:` lines: "Default message" and "Pull request title and commit details" keep the cards. "Pull request title and description" keeps only what is in the PR description, and "Pull request title" drops the whole body, cards included. If you run `chamoji ws ship` on the branch before the squash, the summary saved on the memory ref keeps the cards even then (see below).

### Asking why

```bash
chamoji why src/auth.ts:42
```

It blames the line in your working copy and prints the commit that wrote it, with its date, author and card. A commit with no card shows its workstream instead, when one is known. A line you haven't committed yet says so and exits 0. A file or line that doesn't exist gives a plain message and exits 1. `--json` prints the same result for scripts. It only reads git; nothing is changed or sent anywhere.

### The memory ref

When you mark a workstream shipped or dropped (`chamoji ws ship`, `chamoji ws drop`), chamoji saves a summary of it on `refs/chamoji/memory`: its title, emoji, status, and its commits with their cards. The summary comes from the commits on `HEAD` that name the workstream, so run the command on the branch that holds the work. The ref is written with git plumbing, so your working tree and index are never touched. The summary survives deleting the branch and a squash merge. Both commands say how many commits they saved (`Saved 2 commits to memory.`) and warn when it is none, which means this branch has no commits for that workstream: run the command again on the branch that has them.

```bash
chamoji memory                          # list what is remembered
chamoji memory list --archived          # list the archived entries too
chamoji memory show <slug>              # one entry with its commits and cards
chamoji memory search <query>           # find commits and workstreams by what they say
chamoji memory reindex                  # rebuild the search index
chamoji memory archive <slug>           # hide an entry from the list, and keep it
chamoji memory archive <slug> --purge   # delete it for good
chamoji memory sync                     # merge with origin and push
```

- **Archive, never delete:** `archive` hides an entry from the list and from search, and `memory show` still finds it. `memory list --archived` lists the archived entries with the live ones. Only `--purge` removes one. `memory list` also says when an entry is there but can't be read, instead of calling memory empty.
- **Purge is local until you sync:** it removes the entry from your ref, deletes this worktree's search index, which held the entry's text, and leaves a marker so that a later sync can't bring it back. Other worktrees keep their own index file until their next search, which sees that the memory ref moved and rebuilds it. Purge doesn't reach origin. Run `chamoji memory sync` next: it merges origin's memory into yours first, and if origin still holds the entry it prints the command that removes it there. That command is a force-push, and it replaces origin's memory history with yours, so run it only after a `memory sync` has merged. Chamoji never force-pushes itself. Any other clone that has already fetched the entry still holds the text.
- **A purge keeps the name:** the marker is the slug, and the commit message `Purge <slug>` names it too. Purging removes the content, not the name, and a purged slug can't be saved to memory again, so start that workstream again under a new name.
- **Search** is keyword search (BM25) over every commit on `HEAD`, with its subject, body and card, and over the live workstream entries, not the archived ones. The index is a cache at `.git/chamoji/memory-index.json`. It rebuilds itself when `HEAD` or memory changes, and `memory reindex` forces it. It needs no network and no key. With `--ai`, Jev reorders the ten best matches (see below).

### Sharing memory

```bash
chamoji init              # once per clone
chamoji memory sync       # merge with origin, then push
```

`chamoji init` adds a fetch line for `refs/chamoji/*` to `origin` and takes in whatever memory origin has, so a fresh clone needs only `init`. Git doesn't clone these refs, so every clone runs `init` once. `chamoji memory sync` merges both sides and pushes the result; two clones that remembered different workstreams keep both. The push runs your pre-push hook like any other, and a hook that refuses it is reported as an error. It tries again only when the push lost a race to another clone. `chamoji release --push` also syncs memory, but only in a clone that ran `init`.

**`init` leaves `git push` alone.** The roadmap planned to set `remote.origin.push` so that a plain `git push` would carry memory. Tested, that setting made a plain `git push` push only the memory ref and leave the branch behind, and an explicit `git push origin main` ignored it anyway. So memory goes out through `memory sync` and `release --push`, and `init` sets only the fetch line. Plain `git fetch` and `git pull` keep working before origin has any memory.

**Plain `git fetch` and `git pull` don't change what `chamoji memory` shows.** They download origin's memory into `refs/chamoji/remotes/origin/memory`, and nothing reads it from there. `chamoji memory sync` brings it in, and `chamoji init` says so when it runs.

**Who can change it:** a memory ref is shared with everyone who can push to the repo. Entries that come from origin are data. A pusher can add an entry or change a title or a card, and chamoji never verifies a card. Read them as you would a teammate's commit message. Chamoji prints them with control characters removed, and `chamoji mcp` tells the model they are data, not instructions.

### For AI agents

```bash
chamoji init --agents
```

This does what `init` does, and sets up Claude Code in this repo by merging into two files that are meant to be committed, so everyone who uses Claude Code here gets the same setup. Existing entries are kept, and a file chamoji can't safely read is left alone.

- **`.mcp.json`** gets a `chamoji` server that runs `chamoji mcp`, or `npx --yes @chamoji/cli mcp` when chamoji isn't on your PATH.
- **`.claude/settings.json`** gets the commit hook, below.

**Approve the server.** Claude Code won't run a server from a project's `.mcp.json` until you approve it, and until then `claude mcp list` shows it as Pending approval. Approve it when Claude Code asks.

`chamoji mcp` is a small MCP server over stdio with three tools, all read-only. None changes your history, refs or files; `search_memory` may refresh the index cache in `.git`.

| Tool            | What it does                                                               |
| --------------- | -------------------------------------------------------------------------- |
| `search_memory` | Search commits and remembered workstreams by what they say, cards included |
| `why`           | The commit behind a `file` and `line`, with its message and card           |
| `workstream`    | A workstream's title, status and, once remembered, its commits and cards   |

Everything the tools return is commit text that other people wrote, and each tool says so to the model. Replies are cut to a fixed size, and a cut reply says `truncated: true`. The server makes no network calls, except under `chamoji mcp --ai`, which asks Jev to reorder `search_memory` results with the same limits as `memory search --ai`.

**The commit hook** is a `PreToolUse` hook on Claude Code's Bash tool. When the agent runs a `git commit` whose message has no card line, the hook denies it and says what to add:

> `Add why this change was made: put a "Why: <reason>" line at the end of the commit message, after a blank line. Constraint:, Gotcha: and Follow-up: lines are welcome too. Only if the user told you to skip this, prefix the command with CHAMOJI_NO_CARD=1.`

The agent retries with a `Why:` line. Any one of the four lines counts, as long as chamoji would read it: below the subject paragraph, so `-m "Why: because"` is a subject, not a card. `CHAMOJI_NO_CARD=1` in front of the command is the opt-out, meant for when you've told the agent to skip cards. Commits that take their message from a file or another commit (`-F`, `-C`) and commands that only look (`--dry-run`, `--help`) pass. The hook reads the command text, so a commit hidden inside `sh -c '…'`, `xargs` or a shell alias isn't seen. If anything goes wrong inside the hook, it says nothing and lets the command through, and the committed command ends in `|| true`, so a chamoji too old to know the hook can't block your commits.

The hook covers Claude Code only. Other agents can use the MCP server, but write their cards by hand.

**Not verified:** the `.mcp.json` that `init --agents` writes on native Windows, where `npx` and a `chamoji` shim may need a `cmd /c` wrapper.

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

## Repo card

The Action can also keep a card for your project: an image of your latest release and a few stats about it, to paste into your readme. Each card links back to chamoji. This is chamoji's own, kept up to date by [`card.yml`](.github/workflows/card.yml):

<p align="center">
  <a href="https://chamoji.dev"><img src="https://raw.githubusercontent.com/HeavenlyEntity/chamoji-ai/chamoji-card/card.png" alt="chamoji's repo card: its latest release, release and commit counts, and the share of commits sorted" width="480"></a>
</p>

```yaml
# .github/workflows/card.yml
name: card
on:
  push:
    tags: ['v*']
  schedule:
    - cron: '17 6 * * *'
  workflow_dispatch:
permissions:
  contents: write # the card branch
concurrency:
  group: card # one run at a time, so two pushes can't race for the branch
jobs:
  card:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # chamoji reads every commit and tag
      - uses: HeavenlyEntity/chamoji-ai@v0.9.0
        with:
          mode: card
```

Then paste this into your readme, with your own owner and repo:

```html
<a href="https://chamoji.dev">
	<img
		src="https://raw.githubusercontent.com/<owner>/<repo>/chamoji-card/card.png"
		alt="chamoji card"
		width="480"
	/>
</a>
```

The raw image address only renders for public repositories: a private repo's card won't load for anyone who isn't signed in to GitHub.

- **Where it goes:** a `chamoji-card` branch that holds only `card.png`, replaced on every change. `main` and your tags get no bot commits. `card-branch` renames it, and the `card-url` output is the image's address.
- **What it needs:** `contents: write` and `fetch-depth: 0`. The push uses the credential `actions/checkout` leaves behind, so `persist-credentials: false` won't work.
- **What it never overwrites:** the Action refuses a branch that holds anything other than `card.png`.
- **What is sent:** to `chamoji.dev/api/card`, the repo name, the latest tag, its date and a few counts. Never commit text. A private repo's name reaches `chamoji.dev` this way.
- **Which tags count:** only semver tags, such as `v1.2.3` or `1.2.3`. `tags: ['v*']` doesn't start the workflow for an unprefixed tag, so the daily run picks that one up.
- **If the renderer is down or refuses the card,** the job warns, in the log and the job summary, and doesn't fail. The last card stays, or none exists yet on a first run. A refusal names the tag or repo the renderer wouldn't draw.
- **Scheduled runs pause:** GitHub stops scheduled workflows in a public repository with no activity for 60 days.
- **Releases from `mode: release`:** tags pushed with `GITHUB_TOKEN` don't start workflows, so add a `mode: card` step after the release step. Otherwise the daily run catches up. Mark the card step `continue-on-error: true`, so a card problem never fails a release job:

  ```yaml
  - uses: HeavenlyEntity/chamoji-ai@v0.9.0
    with:
      mode: release
  - uses: HeavenlyEntity/chamoji-ai@v0.9.0
    continue-on-error: true
    with:
      mode: card
  ```

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
- **Memory search:** `chamoji memory search --ai` and `chamoji mcp --ai` send the query and, for each of the ten best matches, at most 300 characters of its subject and card text, with email addresses replaced by `<email>`. Never diffs, code or authors. Jev only reorders what keyword search found; it doesn't write or change a card. The rerank has never run against the real TypeSafe API; on any failure it keeps the keyword order and prints a note. The key comes from the `TYPESAFE_API_KEY` environment variable or an untracked `.env.local` or `.env`. A tracked file is ignored here, because a cloned repo could otherwise name someone else's account.
- **If a request fails:** chamoji stops sending, keeps the picks it already has, and leaves the rest in Miscellaneous.
- **What it never does:** override an emoji or type the author wrote, or mark a change as breaking. Only authors declare breaking changes.
- **Where the key comes from:** the `TYPESAFE_API_KEY` environment variable, or else that one line from `.env.local` or `.env` in the current folder. No other variable in those files is read.
- **Asking once:** Jev's answers are kept in `.git/chamoji/cache.json`, keyed by commit, so the next run doesn't ask about those commits again. The file holds only each commit's pick and confidence.
- **Without `--ai`:** chamoji sends nothing to TypeSafe.

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

## The face and the environment

Commands that wait, such as `memory sync`, show a small face on stderr while they work, with the step's name and a closing line like `( ■‿■ ) ✓ Synced memory with origin: 2 entries in 3s`. A bare `chamoji` plays a short intro. The faces use the logo's foil colours on a dark terminal and plain text on a light one.

- **Nothing moves,** and the output is exactly what it was before, when stderr isn't a terminal, in CI, with `TERM=dumb`, with `--json`, or when `CHAMOJI_NO_ANIMATION=1` is set.
- **It never touches stdout,** so pipes and `--json` are unaffected.
- **Colour** follows `NO_COLOR` and `FORCE_COLOR`. `NO_COLOR` removes the colour but the faces still move.

| Variable                 | Meaning                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAMOJI_NO_ANIMATION=1` | Turn off the moving faces and the intro                                                                                                                         |
| `CHAMOJI_THEME`          | `light` or `dark`. Skips asking the terminal for its background, which chamoji otherwise does once, with `COLORFGBG` as a fallback. Light means no foil colours |
| `CHAMOJI_ASCII=1`        | Draw the faces and the logo in plain ASCII. This is the default on the old Windows console                                                                      |

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
