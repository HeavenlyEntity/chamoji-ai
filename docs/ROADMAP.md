# Chamoji product roadmap

The single source of truth for what we build next and why. Each milestone below gets its own implementation plan in `docs/superpowers/plans/` before work starts. When a milestone ships, update its status, its exit-criteria results and the changelog line.

- **Design and research behind it:** [`docs/research/2026-10-27-chamoji-direction.md`](research/2026-10-27-chamoji-direction.md)
- **Last updated:** 2026-10-28

## Vision

**Make every commit explain itself, to the next developer, the reviewer, the AI agent and the customer.**

Chamoji turns commit history into the record a team actually needs: changelogs that read like product updates, review packets that bring the context to the reviewer, and project memory that survives people leaving. It's free and open source for developers. Teams pay for the outputs that reach people who never open git.

## Principles

These apply to every milestone. A plan that breaks one needs a written reason.

1. **The deterministic path always works.** Every feature works offline and without an API key. AI only ranks, suggests or fills gaps, and a person can override it in one keystroke.
2. **AI never decides for the author.** It never declares a breaking change, overrides what an author wrote, or approves a review.
3. **Context lives in git.** Trailers, notes and refs travel with the repo and work with any host. No platform lock-in.
4. **Send as little as possible.** Network calls are opt-in and minimal, and what's sent is documented. Never send diffs or code without an explicit, separate opt-in.
5. **Developers never pay. The people downstream of their commits do.** The paid tier sells distribution, team-wide sharing and hosting, not the core tool.
6. **Measure, then build.** Every milestone has exit criteria with numbers. We follow the _Software as a Science_ levers in order: acquisition and activation, then retention, then expansion.

## Status

| #   | Milestone                           | Phase                      | Lever       | Size | Status              | Plan                                                                 |
| --- | ----------------------------------- | -------------------------- | ----------- | ---- | ------------------- | -------------------------------------------------------------------- |
| 1   | Changelog engine                    | 0 Foundation               | Activation  | M    | ✅ Shipped in 0.1.0 | [plan](superpowers/plans/2026-10-27-milestone-1-changelog-engine.md) |
| 1.5 | Plain commits, Dependencies, `--ai` | 0 Foundation               | Activation  | M    | ✅ Shipped in 0.2.0 | — (built from chat scope)                                            |
| 2   | Public launch kit                   | 1 Activation & acquisition | Acquisition | S    | ⏭ Next              | —                                                                    |
| 3   | GitHub Action                       | 1 Activation & acquisition | Acquisition | M    | Planned             | —                                                                    |
| 4   | Commit composer and git hook        | 2 Retention                | Retention   | L    | Planned             | —                                                                    |
| 5   | Jev in the composer                 | 2 Retention                | Retention   | M    | Planned             | —                                                                    |
| 6   | Workstreams                         | 3 Differentiation          | Retention   | L    | Planned             | —                                                                    |
| 7   | Project memory                      | 3 Differentiation          | Retention   | L    | Planned             | —                                                                    |
| 8   | Review packets                      | 3 Differentiation          | Expansion   | L    | Planned             | —                                                                    |
| 9   | Retroactive grouping                | 3 Differentiation          | Activation  | M    | Planned             | —                                                                    |
| 10  | Editor extension                    | 4 Surfaces                 | Acquisition | L    | Planned             | —                                                                    |
| 11  | Local daemon on iii                 | 4 Surfaces                 | Retention   | M    | Planned             | —                                                                    |
| 12  | Desktop app (Tauri)                 | 4 Surfaces                 | Retention   | L    | Planned             | —                                                                    |
| 13  | Cloud: hosted release notes         | 5 Expansion                | Expansion   | L    | Planned             | —                                                                    |
| 14  | Cloud: team memory and review       | 5 Expansion                | Expansion   | L    | Planned             | —                                                                    |
| 15  | Cloud: billing and organizations    | 5 Expansion                | Expansion   | M    | Planned             | —                                                                    |

**Statuses:** ✅ shipped · 🚧 in progress · ⏭ next · Planned · ⏸ parked.

**Sizes**, assuming one person with AI help: S is a few days, M is one to two weeks, L is two to four weeks.

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

**Benchmark repos:** gitmoji, gitmoji-cli, sindresorhus/meow and vitejs/vite. Add two more with messy, unstructured history in milestone 2. Every milestone that touches parsing reports before and after numbers on these repos.

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

---

## Phase 1: Activation and acquisition

**Goal:** people can find chamoji, trust it, and get value in their first minute.

### 2. Public launch kit — ⏭ next

**Why:** the npm page has no link to source code. Nobody can star the project, file issues or contribute. Every later milestone depends on people being able to find it.

**Scope:**

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

- The repo is public and CI is green on all three operating systems.
- 0.2.1 is published by the release workflow with provenance.
- The npm page links to GitHub.
- The waitlist page is live.

**Dependencies:** none.

**Open decisions:**

- Which GitHub owner (personal account or a `chamoji` org).
- The waitlist host.

### 3. GitHub Action

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

Fold these into a milestone's plan when they fit, or pull one into a sprint when it's blocking.

- **Emoji variants:** accept variant forms of official gitmojis, such as 👨‍💻 for 🧑‍💻. Found on gitmoji-cli.
- **Confidence cutoff:** 60% held up on meow. Re-check it with the milestone 5 tuning data.
- **Noise prefixes:** more wording-rule coverage for noisy prefixes, such as "Merge remote-tracking…" and "Squashed commit of…".
- **Cloud data store:** choose one for the Cloud tier when milestone 13 is planned.
- **Windows:** the fixture repos and git argument handling haven't been tested there yet; milestone 2's CI will cover it.

## Open decisions

| Decision                                                    | Needed by    | Notes                               |
| ----------------------------------------------------------- | ------------ | ----------------------------------- |
| GitHub owner: personal account or `chamoji` org             | Milestone 2  | An org matches the npm scope        |
| Telemetry: build it at all, or rely on npm and GitHub stats | Milestone 2  | Must be opt-in either way           |
| Default LLM for prose (title drafts, release summaries)     | Milestone 5  | Claude, with a local Ollama option  |
| Cloud hosting and data store                                | Milestone 13 | iii-hosted vs. a conventional stack |
| Pricing                                                     | Milestone 15 | Test on the waitlist first          |

## How we work

1. **Pick the next ⏭ milestone.** Write its implementation plan in `docs/superpowers/plans/YYYY-MM-DD-milestone-N-<name>.md`.
2. **Build it on a branch**, test first.
3. **Get an independent review**, then fix the real findings.
4. **Merge, release and record the results.**
   - Run the benchmark repos when parsing changed.
   - Check the exit criteria.
   - Update this file's status table and the milestone's section.
5. **Use one- or two-week sprints.** A milestone can span several sprints. Each sprint ends with something published or deployable.
