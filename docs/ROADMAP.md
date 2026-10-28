# Chamoji product roadmap

**This is the one document we plan from.** It says what we build, in what order, why, and how we know it worked. It also tracks how we use chamoji on our own projects, because we are its first users.

- **Implementation plans:** each milestone gets one in `docs/superpowers/plans/` before work starts, linked from the status table. Plans say _how_; this file says _what_ and _when_.
- **When a milestone ships:** update its status, its exit-criteria results and the dogfooding log below.
- **Background only:** [`docs/research/2026-10-27-chamoji-direction.md`](research/2026-10-27-chamoji-direction.md) holds the research and reasoning. If it disagrees with this file, this file wins.
- **Look and feel:** [`docs/brand/BRAND.md`](brand/BRAND.md) sets the colours, the holographic foil effect, the type and the rules for every visual surface.
- **Last updated:** 2026-10-28

## Vision

**Make every commit explain itself, to the next developer, the reviewer, the AI agent and the customer.**

Chamoji turns commit history into the record a team actually needs: changelogs that read like product updates, review packets that bring the context to the reviewer, and project memory that survives people leaving. It's free and open source for developers. Teams pay for the outputs that reach people who never open git.

## Principles

These apply to every milestone. A plan that breaks one needs a written reason.

1. **The deterministic path always works.** Every feature works offline and without an API key. AI only ranks, suggests or fills gaps, and a person can override it in one keystroke.
2. **AI never decides for the author.** It never declares a breaking change, overrides what an author wrote, or approves a review.
3. **Context lives in git.** Trailers, notes and refs travel with the repo and work with any host. No platform lock-in.
4. **Send as little as possible.** Network calls are opt-in and minimal, and what's sent is documented. Never send diffs or code without an explicit, separate opt-in. The one exception is the update check (milestone 2): at most once a day, to the npm registry only, sending nothing about the user or their repo, and easy to turn off.
5. **Developers never pay. The people downstream of their commits do.** The paid tier sells distribution, team-wide sharing and hosting, not the core tool.
6. **Measure, then build.** Every milestone has exit criteria with numbers. We follow the _Software as a Science_ levers in order: acquisition and activation, then retention, then expansion.

## Status

| #   | Milestone                           | Phase                      | Lever       | Size | Status                                         | Plan                                                                   |
| --- | ----------------------------------- | -------------------------- | ----------- | ---- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Changelog engine                    | 0 Foundation               | Activation  | M    | ✅ Shipped in 0.1.0                            | [plan](superpowers/plans/2026-10-27-milestone-1-changelog-engine.md)   |
| 1.5 | Plain commits, Dependencies, `--ai` | 0 Foundation               | Activation  | M    | ✅ Shipped in 0.2.0                            | — (built from chat scope)                                              |
| 1.6 | Use it ourselves                    | 0 Foundation               | Retention   | S    | ✅ Shipped in 0.3.0                            | [plan](superpowers/plans/2026-10-28-milestone-1.6-use-it-ourselves.md) |
| 2   | Public launch kit                   | 1 Activation & acquisition | Acquisition | S    | ✅ Done (all items shipped)                    | [plan](superpowers/plans/2026-10-28-milestone-2-public-launch-kit.md)  |
| 3   | GitHub Action                       | 1 Activation & acquisition | Acquisition | M    | ✅ Shipped in 0.5.0 (Marketplace listing left) | [plan](superpowers/plans/2026-10-28-milestone-3a-release-command.md)   |
| 4   | Commit composer and git hook        | 2 Retention                | Retention   | L    | 🚧 Built, release pending                      | [plan](superpowers/plans/2026-10-28-milestone-4-commit-composer.md)    |
| 5   | Jev in the composer                 | 2 Retention                | Retention   | M    | Planned                                        | —                                                                      |
| 6   | Workstreams                         | 3 Differentiation          | Retention   | L    | Planned                                        | —                                                                      |
| 7   | Project memory                      | 3 Differentiation          | Retention   | L    | Planned                                        | —                                                                      |
| 8   | Review packets                      | 3 Differentiation          | Expansion   | L    | Planned                                        | —                                                                      |
| 9   | Retroactive grouping                | 3 Differentiation          | Activation  | M    | Planned                                        | —                                                                      |
| 10  | Editor extension                    | 4 Surfaces                 | Acquisition | L    | Planned                                        | —                                                                      |
| 11  | Local daemon on iii                 | 4 Surfaces                 | Retention   | M    | Planned                                        | —                                                                      |
| 12  | Desktop app (Tauri)                 | 4 Surfaces                 | Retention   | L    | Planned                                        | —                                                                      |
| 13  | Cloud: hosted release notes         | 5 Expansion                | Expansion   | L    | Planned                                        | —                                                                      |
| 14  | Cloud: team memory and review       | 5 Expansion                | Expansion   | L    | Planned                                        | —                                                                      |
| 15  | Cloud: billing and organizations    | 5 Expansion                | Expansion   | M    | Planned                                        | —                                                                      |

**Statuses:** ✅ shipped · 🚧 in progress · ⏭ next · Planned · ⏸ parked.

**Sizes**, assuming one person with AI help: S is a few days, M is one to two weeks, L is two to four weeks.

## Using chamoji ourselves

We use every release on our own projects before anyone else does. If something annoys us, it goes in the backlog before we build anything new.

**Rule:** a milestone isn't done until we have used it on our own repos for at least one sprint.

**What we can use today (0.2.0):**

- `npx @chamoji/cli changelog --output CHANGELOG.md` on any of our repos.
- `npx @chamoji/cli next-version` to choose the version when cutting a release.
- `--ai` with `TYPESAFE_API_KEY` set, for the commits the rules can't place.
- Writing commits with a gitmoji or a Conventional prefix, plus a `Why:` line at the end, so the history is ready for workstreams and memory later.

**Repos using it:**

| Repo                          | Since | How                                                                                                                                                                                 | Friction found                |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| chamoji-ai (our product repo) | 0.1.0 | Generates its own `CHANGELOG.md`; since 0.3.0, `pnpm release` picks the version, bumps both packages, writes the changelog, commits and tags; since 0.5.0 it runs `chamoji release` | See the milestone 1.6 results |

**What each upcoming milestone gives us:**

| Milestone             | What changes in our own work                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| 1.6 Use it ourselves  | Our product's changelog is generated, not written by hand                       |
| 3 GitHub Action       | Release notes appear on every tag with no manual step                           |
| 4 Composer and hook   | Every commit we write is consistent, with no extra effort                       |
| 5 Jev in the composer | The right gitmoji is preselected; breaking changes are flagged before they ship |
| 6 Workstreams         | Our releases read as features, not commit lists                                 |
| 7 Project memory      | Our AI agents (Claude Code, Cursor) know _why_ the code is the way it is        |
| 8 Review packets      | Our PR reviews come with context, especially for agent-written code             |

## Metrics

We track these from milestone 2 onward. The targets are hypotheses, revised as data arrives.

| Lever       | Metric                                                     | How we measure it                                        | First target                                   |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Acquisition | Weekly npm downloads of `@chamoji/cli`                     | npm stats                                                | 250/week by the end of phase 1                 |
| Acquisition | GitHub stars and Action installs                           | GitHub                                                   | 500 stars, 50 repos using the Action           |
| Activation  | First run is useful: under 25% of commits in Miscellaneous | Our benchmark repos, plus opt-in telemetry (milestone 2) | Benchmark median under 20% without `--ai`      |
| Retention   | Repos still running the hook 30 days after install         | Opt-in telemetry                                         | 40%                                            |
| Retention   | Commits written with the composer each week                | Opt-in telemetry                                         | Grows week over week through phase 2           |
| Expansion   | Teams on a paid Cloud plan                                 | Billing                                                  | 10 paying teams within 90 days of milestone 15 |

**Benchmark repos:** gitmoji, gitmoji-cli, sindresorhus/meow and vitejs/vite, plus jquery/jquery and moment/moment for messy, unstructured history. `pnpm benchmark` clones them and prints each one's Miscellaneous share. Every milestone that touches parsing reports before and after numbers on these repos.

---

## Phase 0: Foundation ✅

### 1. Changelog engine (0.1.0)

A pnpm workspace with `@chamoji/core` and `@chamoji/cli`.

- `chamoji changelog` writes Markdown, HTML or JSON.
- `chamoji next-version` suggests the next version.
- It reads gitmoji and Conventional Commits, uses the full official gitmoji list, and parses trailers.
- Tests run against throwaway git repos.
- Two independent reviews; all findings fixed.

### 1.5. Plain commits, Dependencies, `--ai` (0.2.0)

- Wording rules sort plain messages ("Add…", "Fix…").
- Dependency updates collapse to one line.
- `--ai` sends the commits rules can't place to Jev, with minimal data and safe failure.

| Benchmark | Miscellaneous before | After rules | After rules + `--ai` |
| --------- | -------------------- | ----------- | -------------------- |
| meow      | 100%                 | 24%         | 19%                  |
| vite      | 27%                  | 16%         | —                    |

Live Jev run on meow: 9–10 of 28 leftover commits sorted, about 0.3 seconds, $0.0017.

### 1.6. Use it ourselves — ✅ shipped in 0.3.0

**Why:** we built chamoji to automate our own changelogs. Using it on our product repo is the fastest way to find what's missing, and it gives the public launch a real example to show.

**Scope:**

- **Add chamoji to our product repo:**
  - a `chamoji.config.json` if the default sections don't fit
  - a release script: `next-version`, then `changelog --release`, then commit and tag
  - the `--ai` key in CI secrets or a local `.env` file, never committed
- **Agree on a commit convention** for the team: gitmoji or Conventional prefixes, plus an optional `Why:` trailer. Write it down in that repo's contributing notes.
- **Cut one real release** with the generated changelog and record:
  - how many commits landed in Miscellaneous
  - anything we had to fix by hand
- **Log every piece of friction** in the backlog, tagged _dogfood_.

**Exit criteria:**

- One real release of our product shipped with a chamoji changelog and no hand edits, or with the hand edits written up as backlog items.
- The team commit convention is written down.

**Dependencies:** none. It uses 0.2.0 as published.

**Decided:** our product repo is chamoji-ai itself.

**Results:**

| Friction we hit                                                                       | Fix                                                                                                           | Shipped |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| A TypeSafe key copied from the dashboard ended in "…" and failed with a cryptic error | Clear "looks truncated" error, key never printed                                                              | 0.2.0   |
| `--ai` couldn't use the key in `.env.local`; it had to be passed by hand              | `TYPESAFE_API_KEY` is read from `.env.local` or `.env`, and only that variable                                | 0.3.0   |
| `.env.local` wasn't git-ignored                                                       | `.env` and `.env.*` are ignored                                                                               | 0.3.0   |
| Version bumps, changelog and tag were done by hand, in three steps that could drift   | `pnpm release` (with `--dry-run`); it refuses dirty trees and non-main branches, and undoes itself on failure | 0.3.0   |
| 📝 docs commits filled Miscellaneous (7 of 27 commits)                                | A default Documentation section; Miscellaneous is now 1 of 31                                                 | 0.3.0   |

- **Commit convention:** written down in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **Release v0.3.0:** cut with `pnpm release`, with no hand edits to the generated changelog.
- **Still manual:** publishing (`pnpm publish -r`). The release workflow in milestone 2 replaces it.

---

## Phase 1: Activation and acquisition

**Goal:** people can find chamoji, trust it, and get value in their first minute.

### 2. Public launch kit — ✅ done

**Progress (2026-10-28):**

- ✅ **Update notice**, in 0.4.0: once a day at most, detached, stderr only, off in CI. Reviewed and hardened.
- ✅ **Public repo** at [github.com/HeavenlyEntity/chamoji-ai](https://github.com/HeavenlyEntity/chamoji-ai): code of conduct, security policy, issue and PR templates, the foil logo and badges.
- ✅ **CI** is green on Linux, macOS and Windows with Node 22 and 24.
- ✅ **v0.4.0** was published by `release.yml` through npm trusted publishing, with SLSA provenance on both packages. The npm pages link to GitHub.
- ✅ **Old versions deprecated:** 0.1.0, 0.2.0 and npm's `0.0.0-stage` placeholder on both packages. Installing them prints an "update to the latest" warning.
- ✅ **Readme demo GIF** (`docs/demo.gif`): a messy plain-message log, chamoji sorting it, then `chamoji release`. Re-render it with `vhs docs/demo/demo.tape` after `pnpm build`.
- ✅ **Cloud waitlist page** is live at [chamoji.dev](https://chamoji.dev), built from the Claude Design [canvas](https://claude.ai/artifact/PZE5BypQRLgUjNH61ERMxc) (private) in the private `HeavenlyEntity/chamoji-web` repo. That repo holds the licensed fonts, art and React Bits Pro (agentframe) code, which can't live in this public repo. Emails go to Neon Postgres through the Vercel Marketplace, stored once each, whatever the capitalisation. The custom domain, chamoji.dev, is live. Still to do: the Organization plan's contact email, and a Vercel Firewall rate limit if spam turns up.
- ✅ **Two messy benchmark repos:** jquery/jquery and moment/moment, measured with `pnpm benchmark` on 2026-10-28, without `--ai`, over each repo's whole history:

  | Repo                     | Commits | Miscellaneous |
  | ------------------------ | ------- | ------------- |
  | carloscuesta/gitmoji     | 1308    | 2%            |
  | carloscuesta/gitmoji-cli | 1167    | 1%            |
  | sindresorhus/meow        | 160     | 18%           |
  | vitejs/vite              | 8685    | 2%            |
  | jquery/jquery            | 6545    | 42%           |
  | moment/moment            | 3060    | 41%           |

  The median is 10%, inside the 20% target. The two messy repos were the gap, so a parsing pass after 0.5.0 targeted them:
  - it reads `Component: description` and `[tag] description` prefixes through to the subject behind them
  - it hides release chores and merge leftovers
  - it adds the "Made"/"Makes" and hand-written "Revert …" verbs
  - it moves ✏️ typo fixes to Documentation

  | Repo          | Before | After |
  | ------------- | ------ | ----- |
  | jquery/jquery | 42%    | 31%   |
  | moment/moment | 41%    | 28%   |

  The other four didn't move. Both are still above the 25% "first run is useful" line. The rest is mostly subjects with no verb rule, such as "Don't …", "Only …" or "Bug 1234 …", and is the `--ai` comparison to make next.

- ✅ **New About text** on the repo, matching the readme.

**What we learned getting the release to publish:**

- Tarball paths need a leading `./`, or npm reads them as GitHub shorthand.
- `setup-node`'s `registry-url` writes a placeholder token that blocks trusted publishing.
- On npm, the trusted publisher lives on each package's **Settings** tab (`/package/<name>/access`), and direct `npm publish` has to be ticked under **Allowed actions**.

**Why:**

- **Nobody can find or follow chamoji yet.** The npm page has no link to source code, so nobody can star the project, file issues or contribute. Every later milestone depends on people being able to find it.
- **People already using it don't know when it improves.** Each release fixes real problems, and users have no way to hear about the fixes.

**Scope:**

- **Update notice, done first.** When a newer version of `@chamoji/cli` is out, tell the user, once, after their command finishes:

  ```
  chamoji 0.4.0 is available (you have 0.3.0): npm i -g @chamoji/cli@latest
  ```

  - **When it checks:** at most once every 24 hours. The result is cached in the user config directory (`~/.config/chamoji/update-check.json`, or the platform equivalent).
  - **It never slows a command down.** The check runs in the background with a short timeout. Its result is shown on the next run if it isn't ready yet. A failed or offline check stays silent.
  - **It never interferes with output.** The notice goes to stderr only, never stdout, so `--format json`, pipes and `$(chamoji next-version)` are unaffected.
  - **Where it stays off:**
    - in CI (`CI` is set) and when stderr isn't a terminal
    - with `NO_UPDATE_NOTIFIER` or `CHAMOJI_NO_UPDATE_CHECK=1`
    - with `--no-update-check`
  - **Install command shown:** matched to how chamoji was run. `npx` users are told about `npx @chamoji/cli@latest`, global installs about `npm i -g`, and project installs about updating `package.json`.
  - **Implementation:** a small module of our own, or `update-notifier`, which gitmoji-cli uses. Choose in the plan, weighing dependency size.
  - **What it sends:** a single GET request to `registry.npmjs.org` for the package's latest version, and nothing else. The readme says so.

- **Reach users of the old versions.** 0.1.0 and 0.2.0 have no update check, so they can't be told this way. Instead, `npm deprecate @chamoji/cli@"<0.3.0"` with an "update to the latest" message, which npm shows whenever someone installs those versions. Then, once the update check ships, put a note in the release notes.

- **Public GitHub repo.**
  - `repository`, `homepage` and `bugs` fields in both packages.
  - Republish as 0.2.1 so npm links back to GitHub.
- **CI with GitHub Actions** on pushes and PRs: `pnpm check` and `pnpm test` on Node 22 and 24, on macOS, Linux and Windows.
- **A release workflow** that publishes to npm from a tag, using npm provenance (trusted publishing). This replaces manual `pnpm publish`.
- **Repo files:**
  - a readme demo, either a GIF or an asciinema recording of a plain repo before and after
  - `CONTRIBUTING.md` and a code of conduct
  - issue and PR templates
  - a security policy
- **Config file support:** read `.env` and `.env.local` for `TYPESAFE_API_KEY`, opt-in through `--env-file`, or document Node's built-in `--env-file` flag.
- **Opt-in telemetry design.** Document it before building anything: off by default, what's collected (command, counts, timings; never commit text), and how to turn it on.
- **A Cloud waitlist page** (a one-page site) to test demand for the paid tier before building it.
- **Benchmark:** add two messy real-world repos and record the numbers.

**Out of scope:** new parsing features.

**Exit criteria:**

- A user on the previous version sees one update notice after a command, in a terminal. They see none in CI, in `--format json` output, or with the notice turned off. Tests cover each case.
- `npm install @chamoji/cli@0.1.0` shows the deprecation message.
- The repo is public and CI is green on all three operating systems.
- 0.2.1 is published by the release workflow with provenance.
- The npm page links to GitHub.
- The waitlist page is live.

**Dependencies:** none.

**Decided (2026-10-28):**

- **Repo:** `github.com/HeavenlyEntity/chamoji-ai`.
- **Telemetry:** none. Retention is read from npm downloads, Action installs and GitHub activity, and the telemetry item above is dropped.
- **Waitlist:** a branded page on Vercel.
- **Publishing:** 0.3.0 isn't published on its own. v0.4.0 is the first release published by CI, with provenance.

### 3. GitHub Action

**Progress (2026-10-28):**

- ✅ **`chamoji release`**, the command the Action wraps. It cuts a release in one go:
  - it checks for a clean tree, the default branch and full history
  - it picks the version from the commits, or takes the one given
  - it adds chamoji's section above the last release in `CHANGELOG.md`, with older entries untouched
  - it bumps `package.json`, `package-lock.json`, `pyproject.toml` and `Cargo.toml`
  - it makes a release commit in the repo's style and an annotated tag
  - with `--push`, it pushes and creates the GitHub release

  `--dry-run` and `--json` are for agents and CI. It ports the script the `chamoji-release` agent skill was tested with, and chamoji-ai's own `pnpm release` now runs it.

- ✅ **The Action** (`action.yml` at the repo root, logic in `action/run.sh`):
  - release notes on every pushed tag
  - one PR comment, kept up to date, with the lines the PR adds and the next version
  - an optional `mode: release`
  - built on a new `changelog --since <ref>`
  - tested against fixture repos with a fake `gh`
  - chamoji runs it on its own PRs and tags from the local build (`.github/workflows/chamoji.yml`)
- ✅ **A real PR comment, updating in place:** on [#1](https://github.com/HeavenlyEntity/chamoji-ai/pull/1) it posted one preview, then updated that same comment on the next push.
- ✅ **Notes on a real tag:** the Action wrote the [v0.5.0 release notes](https://github.com/HeavenlyEntity/chamoji-ai/releases/tag/v0.5.0). 0.5.0 is on npm with provenance.
- ✅ **0.5.0 published:**
  - the skill runs `npx @chamoji/cli release`, with no bundled script, and its CI notes use the Action
  - the readme pins the Action to `@v0.5.0`
- ⬜ **Marketplace listing.**

**Why:** distribution. Every repo that adds the Action shows chamoji in its workflows and release notes. gitmoji-changelog users asked for one (its issue #143).

**Scope:**

- A `chamoji/changelog-action` that:
  1. On tag push, writes release notes to the GitHub Release body. Optionally commits `CHANGELOG.md`.
  2. On a PR, posts or updates one comment: "this PR would add these lines to the changelog", plus the suggested version bump.
  3. Optionally runs `--ai` using a repo secret.
- Marketplace listing and docs.

**Exit criteria:**

- Used on chamoji's own repo for the 0.3.0 release.
- Works on a Conventional repo and a plain-message repo.
- Updates the PR comment in place, with no duplicates.

**Dependencies:** milestone 2.

---

## Phase 2: Retention

**Goal:** chamoji is in the path of every commit, not only every release.

### 4. Commit composer and git hook

**Progress (2026-10-28):** built, waiting for its release.

- ✅ **`chamoji commit`** with the Ink composer:
  - gitmoji search, then scope, title, body, why and breaking
  - Enter moves on, Esc goes back, Ctrl-C cancels
  - `emojiFormat`
  - a `Why:` trailer
- ✅ **`chamoji hook install` / `uninstall`** for `prepare-commit-msg`, with gitmoji-cli's edge cases:
  - it skips -m, merges, squashes, amends, rebases, CI, messages that already have a gitmoji, and anything without a terminal
  - Ctrl-C never blocks the commit
  - it opens `/dev/tty` itself (CONIN$ on Windows)
- ✅ **One-command switch:** install replaces gitmoji-cli's hook and reads `.gitmojirc.json` and the `gitmoji` key in `package.json`.
- ✅ **husky and lefthook:** install prints the line, or the `lefthook.yml` snippet, to add.
- ✅ **Exit-criteria checks:** `scripts/hook-e2e.py` makes real commits through the hook. The Hook workflow runs it for bash, zsh, fish and PowerShell on Linux and macOS, for husky and lefthook, and on Windows without a terminal.
  - Passed locally for bash, zsh, husky and lefthook.
  - fish and PowerShell are checked by the workflow's first run.
  - The interactive composer on Windows (CONIN$) isn't covered by a test yet.

**Why:** running a changelog happens once per release, which is too rare to build a habit. Writing commits happens every day.

**Scope:**

- **`chamoji commit`**, an interactive Ink screen. It offers:
  - fuzzy gitmoji search
  - scope, title, body and a short "why?" field
  - a breaking-change toggle
- **`chamoji hook install` / `uninstall`**, for a `prepare-commit-msg` hook. It follows gitmoji-cli's edge-case rules:
  - skip amends, merges and rebases
  - skip messages that already have an emoji
  - Ctrl-C never cancels the commit
  - reattach the terminal so prompts work
- **`.gitmojirc.json` and the `gitmoji` key in `package.json`** are read, so gitmoji-cli users can switch with nothing to change.
- **`emojiFormat`:** emoji or code.
- **A `Why:` trailer** written from the "why?" field. It becomes the first intent card (milestone 7).

**Out of scope:** AI.

**Exit criteria:**

- Works in zsh, bash, fish and PowerShell.
- Works with husky and lefthook.
- Doesn't break `git commit -m` or editors' commit UIs.
- A gitmoji-cli user can switch by running one command.

**Dependencies:** milestone 2 (CI on all operating systems).

### 5. Jev in the composer

**Why:** speed. The right gitmoji preselected in about 100 ms, and breaking changes caught before they ship.

**Scope:**

- **Commit-time questions**, all in one System One request, built from the staged diff summary, file list and draft message:
  - rank the top three gitmojis
  - "is this breaking?"
  - "should this be split?"
- **Diff privacy:**
  - diff content is sent only with a separate opt-in (`ai.sendDiffs`)
  - by default, only file paths and stats are sent
  - a path denylist (`.env*`, keys, lockfiles)
- **A judgment cache** in `.git/chamoji/cache`, keyed by commit hash or diff hash. `changelog --ai` then stops re-asking about old commits.
- **Tune the confidence cutoffs** on labelled history: the gitmoji repos' own emojis serve as the labels.
- **Optional prose:** a pluggable LLM drafts the title, using Claude or a local model through Ollama.

**Exit criteria:**

- The composer opens with a suggestion in under 300 ms (p95, warm).
- Gitmoji top-3 accuracy is at least 80% on held-out labelled commits.
- A second `changelog --ai` run makes no requests for commits it already sorted.

**Dependencies:** milestone 4.

---

## Phase 3: Differentiation

**Goal:** the features nobody else has. They group work by intent, keep context alive, and focus reviewers' attention.

### 6. Workstreams

**Scope:**

- A `Workstream:` trailer.
- `.chamoji/workstreams.yml`, with title, emoji, description, status and links.
- Local active-workstream state in `.git/chamoji/active`.
- `chamoji ws start | switch | list | ship | drop`.
- The hook stamps the active workstream onto commits.
- Changelog **Highlights:** one entry per shipped workstream, with its commits folded underneath.

**Exit criteria:**

- Trailers survive a GitHub squash merge, tested on a real repo.
- A 40-commit release renders as 5 or fewer Highlights plus loose commits.

**Dependencies:** milestone 4.

### 7. Project memory

**Scope:**

- **Intent cards** as trailers: `Why`, `Constraint`, `Gotcha`, `Follow-up`.
- **`refs/chamoji/memory`** for workstream summaries. `chamoji init` configures push and fetch refspecs.
- **Archive, never delete.** `--purge` is needed for a hard delete.
- **`chamoji why <file:line>`** runs blame and then shows that commit's card.
- **`chamoji mcp`**, an MCP server exposing `search_memory`, `why` and `workstream`.
- **A local search index:** BM25 first, embeddings optional, rebuilt with `chamoji memory reindex`. Jev reranks the results.
- **A hook for AI agents** to write their own intent card at commit time.

**Exit criteria:**

- Claude Code can answer "why is this line like this?" through `chamoji mcp` on chamoji's own repo.
- Memory survives deleting a branch and a fresh clone.

**Dependencies:** milestone 6.

### 8. Review packets

**Scope:**

- **`chamoji review <workstream|range>`** writes Markdown or HTML with these sections:
  - goal and decisions
  - per-commit intent
  - reading order
  - "needs human eyes" risk scores
  - claim check (does the diff do what the `Why` says?)
  - AI-authored commits
  - "since you last looked"
- **The Action** posts the packet as one PR comment and updates it in place.
- **Graphite research spike:** how `gt` stores and exposes stack metadata, so a packet can follow a stack.

**Exit criteria:**

- On 10 real PRs, reviewers say the packet saved time: at least 7 of 10 in a short survey.
- No packet section ever blocks a merge.

**Dependencies:** milestones 3 and 7. Risk scoring and claim checks also need milestone 5's diff opt-in.

### 9. Retroactive grouping

**Scope:**

- **`chamoji group --since <tag>`:** Jev suggests workstreams for ungrouped history. You review the suggestions in a TUI, and they're written as git notes, so no history is rewritten.

**Exit criteria:**

- On chamoji's own history, at least 80% of suggested groupings are accepted without edits.

**Dependencies:** milestones 6 and 7.

---

## Phase 4: Surfaces

**Goal:** chamoji wherever developers already are.

### 10. Editor extension

**Look:** follow [`docs/brand/BRAND.md`](brand/BRAND.md). The foil effect is for the sidebar header, the active-workstream badge and primary actions; everything else follows the editor's own theme.

**Scope:**

- **One extension**, published to the VS Code Marketplace and Open VSX (Cursor, Windsurf, VSCodium). It provides:
  - a Source Control commit helper
  - a workstream sidebar and the active workstream in the status bar
  - a "why" hover
  - a review packet view
- **Built on `@chamoji/core`**, or on the daemon when it's running.

**Exit criteria:**

- Installs in VS Code and Cursor.
- The commit helper fills the commit box in under 300 ms.
- 100 installs in the first month.

**Dependencies:** milestones 5 and 7. The packet view also needs milestone 8.

### 11. Local daemon on iii

**Scope:**

- **Spike first:** register core functions with `iii-sdk`, and confirm the MCP worker exposes them.
- **Then `chamoji daemon`:**
  - a background indexing queue
  - state triggers for live UI updates
  - a cron job that reindexes
- **Pin the iii version.** Confirm ELv2 licensing for the Cloud tier.

**Exit criteria:**

- Indexing after a commit never adds latency to the commit.
- The extension and desktop app get live updates.

**Dependencies:** milestone 7.

### 12. Desktop app (Tauri)

**Look:** built on [`docs/brand/BRAND.md`](brand/BRAND.md): the holographic foil plate, the pastel stops and ink text, light and dark themes. The foil is the `ChamojiFoil` preset over Iridescence, the display type is Marow Block and the UI type is Tansa Bold, both embedded in the app bundle. Start with a design pass that adds Tansa's lighter weights for body copy, if available, and produces the missing SVG and icon assets.

**Scope:**

- **Tauri 2**, with the iii engine and the chamoji worker as bundled sidecars.
- **A workstream board:** drag commits to regroup them.
- **A live changelog preview** and a packet viewer.

**Exit criteria:**

- An installer under 30 MB on macOS, Windows and Linux.
- Opens a 10k-commit repo in under 2 seconds.

**Dependencies:** milestone 11.

---

## Phase 5: Expansion (paid)

**Goal:** revenue from the people downstream of commits.

**Starting pricing hypothesis:** per team or per repo, tied to value delivered, not per developer seat. Treat the price as an experiment and change it often.

### 13. Cloud: hosted release notes

The first paid wedge. It's the lowest build cost, because the engine exists, and it has the clearest buyer: product managers and founders.

**Scope:**

- **A hosted public changelog page for each project**, with a custom domain.
- **Audience versions:** a customer summary written by an LLM from workstreams and intent cards, alongside the engineering version.
- **Slack and email digests.**
- **Sync** from the Action or the CLI.

**Exit criteria:**

- Five waitlist teams using it.
- At least two of them converting to paid when billing lands.

**Dependencies:** milestones 3 and 6, and the waitlist from milestone 2.

### 14. Cloud: team memory and review

**Scope:**

- **Team sync for project memory** and a shared search index ("context insurance").
- **Onboarding packs per workstream.**
- **Review packets for private repos in CI,** with history across PRs.

**Dependencies:** milestones 7, 8 and 11.

### 15. Cloud: billing and organizations

**Scope:**

- Accounts, organizations and roles.
- Usage metering.
- Billing.
- Plan limits.
- Audit log.
- A data-retention policy and a data processing agreement (DPA).

**Dependencies:** milestone 13.

---

## Backlog and known debts

Fold these into a milestone's plan when they fit, or pull one into a sprint when it's blocking. Items found while using chamoji ourselves are tagged _dogfood_ and go first.

- **Downloads badge:** add the npm downloads badge back to the readme once shields.io has data for `@chamoji/cli`. It shows "package not found or too new" until then.
- **Emoji variants:** accept variant forms of official gitmojis, such as 👨‍💻 for 🧑‍💻. Found on gitmoji-cli.
- **Confidence cutoff:** 60% held up on meow. Re-check it with the milestone 5 tuning data.
- ~~**Noise prefixes:**~~ "Merge remote-tracking…", "Squashed commit of…" and jQuery's "Landing pull request…" are handled since the post-0.5.0 parsing pass.
- **Cloud data store:** choose one for the Cloud tier when milestone 13 is planned.
- **Brand assets** (see `docs/brand/BRAND.md`): the display font is Marow Block and the foil is Iridescence. Still to make: an SVG logo with the wordmark outlined, app icons, a favicon and a social preview image. Needed by milestone 2's readme and milestone 10.
- **Windows:** the fixture repos and git argument handling haven't been tested there yet; milestone 2's CI will cover it.

## Open decisions

| Decision                                                | Needed by    | Notes                                                                                                                                                                   |
| ------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~GitHub owner~~                                        | Milestone 2  | **Decided 2026-10-28:** `HeavenlyEntity/chamoji-ai` (personal account; can move to an org later, and GitHub redirects old links)                                        |
| ~~Telemetry~~                                           | Milestone 2  | **Decided 2026-10-28:** no telemetry. We use npm downloads, GitHub stars and Action installs                                                                            |
| Default LLM for prose (title drafts, release summaries) | Milestone 5  | Claude, with a local Ollama option                                                                                                                                      |
| Cloud hosting and data store                            | Milestone 13 | iii-hosted vs. a conventional stack                                                                                                                                     |
| Pricing                                                 | Milestone 15 | **2026-10-28:** test it with the waitlist before setting a price. The waitlist page shows the Cloud Team price as "TBA", priced per repository with unlimited teammates |

## How we work

1. **Pick the next ⏭ milestone.** Write its implementation plan in `docs/superpowers/plans/YYYY-MM-DD-milestone-N-<name>.md`.
2. **Build it on a branch**, test first.
3. **Get an independent review**, then fix the real findings.
4. **Merge, release and use it ourselves for a sprint.** Log friction in the backlog as _dogfood_.
5. **Record the results.**
   - Run the benchmark repos when parsing changed.
   - Check the exit criteria.
   - Update this file's status table and the milestone's section.
6. **Use one- or two-week sprints.** A milestone can span several sprints. Each sprint ends with something published or deployable.
