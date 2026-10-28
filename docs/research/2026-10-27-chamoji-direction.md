# Chamoji: where it is and where it could go

_Draft for discussion, 2026-10-27. Research and proposal only: no code has been changed yet._

## 1. What exists today

Chamoji is a [create-ink-app](https://github.com/vadimdemedes/create-ink-app) scaffold with a partial port of `gitmoji-changelog`:

```
cli.tsx (meow flags: --config, --format)
  └─ app.tsx (one big useEffect)
       ├─ gitUtils.getGitTags()          git tag --sort=-v:refname, semver tags only
       ├─ changelogGenerator.getReleaseData(tag, prevTag)
       │     └─ gitUtils.getCommitsBetween()   git log prev..tag --pretty="%h;%s"
       │     └─ emojiMapping.findMatchingEmoji()   :code: or unicode, first group wins
       └─ render markdown | json | html into one <Text>
config/defaultGroupConfig.ts   Added / Changed / Breaking / Deprecated / Removed / Fixed / Security / Useless / Misc
```

The pipeline is sound: tags → commit ranges → classify by emoji → group → render. The implementation does not work yet:

| Problem                                                                                                             | Where                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Does not compile: arguments passed in the wrong order, and `groupConfig` is sent as a JSON string                   | `source/app.tsx:75`, `source/utils/changelogGenerator.ts:20` |
| Markdown (the default format) is built but never passed to `setChangelogOutput`, so output is empty                 | `source/app.tsx:143`                                         |
| Link syntax is swapped: HTML output gets Markdown links, Markdown output gets `<li>` tags                           | `source/app.tsx:116`, `:143`                                 |
| The effect depends on state it sets, so it re-runs up to 4 times and reads stale `packageVersion` / `repositoryURL` | `source/app.tsx:156`                                         |
| Only the subject line (`%s`) is read: no body, author, trailers, or `BREAKING CHANGE:` footers                      | `source/utils/gitUtils.ts:24`                                |
| Hand-copied subset of about 40 gitmojis; the official list has about 75, with a `semver` field per emoji            | `source/utils/emojiMapping.ts`                               |
| Ink renders a one-shot text dump. Ink adds nothing here and wraps or garbles long output                            | `source/app.tsx`                                             |
| `dist/`, `readme.md` and `test.tsx` are still the "Hello, Jane" template. Not a git repo yet                        | —                                                            |

**Takeaway:** keep the idea and the group config, and rebuild the engine as a plain library. Use Ink where it is strong: interactive flows such as composing a commit or reviewing groups.

## 2. Market research

Full findings with sources are in section 7. In short:

- **The gitmoji changelog tool chamoji copies is effectively dead.** The last release was in 2022 and 50 issues are open. Nobody owns "gitmoji → changelog" right now.
- **AI commit tools write _what_, not _why_.** They also choke on big diffs.
- **Changelogs built from commits are noise.** Teams are giving up on them.
- **Squash merges force a choice.** Teams either lose structure or keep noise.
- **Stacking tools organize review order.** GitHub stacked PRs went into preview in July 2026, alongside Graphite and jj. None of them names a _logical_ group of work that flows into the changelog.

## 3. Proposed architecture

```
chamoji/                      pnpm workspace
├─ packages/core              pure TS, no UI, no network
│   ├─ git/       read log with NUL-separated fields: hash, author, date, subject, body, trailers, notes
│   ├─ parse/     gitmoji (:code: + unicode, variation-selector safe) + Conventional Commits + trailers
│   ├─ gitmojis/  vendored from the official `gitmojis` package (emoji, code, description, semver)
│   ├─ group/     emoji → section rules (today's GroupConfig), workstreams (section 4)
│   ├─ version/   next semver from the gitmoji `semver` field + breaking flags
│   └─ render/    markdown | json | html | keep-a-changelog, template-able
├─ packages/ai                optional; core works fully without it
│   ├─ judge.ts   Jev (TypeSafe System One): typed, fast judgments
│   └─ write.ts   generative LLM (pluggable: Claude, local Ollama) for prose only
├─ packages/cli               meow + Ink
│   ├─ chamoji commit         interactive composer (Ink)
│   ├─ chamoji changelog      non-interactive, writes file / stdout (no Ink)
│   ├─ chamoji ws …           workstreams (section 4)
│   ├─ chamoji hook install   prepare-commit-msg + commit-msg hooks
│   └─ chamoji serve --stdio  JSON-RPC, so a GUI or editor can drive the same engine
└─ apps/desktop               Tauri 2 shell (section 6), later
```

### 3b. Using iii as the backend for the daemon, desktop app and cloud

[iii](https://iii.dev) ([iii-hq/iii](https://github.com/iii-hq/iii), 18.9k★, v0.25.0 on 2026-10-22) is a Rust backend engine built on three primitives:

- **Functions** (ids like `memory::search`).
- **Triggers**: direct call, HTTP, cron, queue, state change.
- **Workers**: processes in any language that register functions through `iii-sdk` (npm, Apache-2.0).

Its registry has ready-made workers for state/KV, queues with dead-letter, cron, HTTP, database (Postgres/MySQL/SQLite), storage (S3/R2/local), OpenTelemetry observability, an LLM router and MCP. The engine itself is Elastic License 2.0.

**Decision: iii is the backend for everything that runs in the background, and never a requirement for the CLI.** A git hook has to start in milliseconds with zero setup, and a free tool can't ask people to install and run a Rust daemon before their first commit.

How that works:

- `packages/core` exposes its operations as plain async functions, each with a stable id: `changelog::build`, `commit::judge`, `ws::list`, `memory::search`, `memory::index`. The CLI imports them directly.
- `packages/iii-worker` is a thin adapter that registers those same functions with iii. It is one codebase with two ways in.

| Tier                                             | Runs                                                 | What iii gives us that we'd otherwise build ourselves                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI (free)**                                   | No iii                                               | —                                                                                                                                                                                                                                                                             |
| **Local daemon (free, opt-in)** `chamoji daemon` | iii engine on localhost + chamoji worker             | **Queue:** embedding and Jev reranking run after each commit without blocking it. **State triggers:** live updates to the desktop board. **Cron:** periodic reindex. **MCP worker:** exposes `memory::search` and friends to Claude Code/Cursor. **Console:** traces for free |
| **Desktop app (free)**                           | Tauri UI → local iii (HTTP/WebSocket)                | Replaces the custom `serve --stdio` JSON-RPC plan. The UI calls functions and subscribes to state                                                                                                                                                                             |
| **Cloud (paid, later)**                          | Same worker on hosted iii + database/storage workers | Team memory sync, shared vector index, org-wide workstream board, hosted LLM routing. Same function ids, so it's a deployment change, not a rewrite                                                                                                                           |

Risks to keep in view:

- **iii is pre-1.0 and changes fast.** `registerTrigger` started giving a deprecation warning in 0.25. Keep the adapter small and pin the engine version.
- **License.** ELv2 allows running iii inside your own paid product, but doesn't allow offering iii itself as a managed service. Chamoji Cloud is the former; confirm with whoever handles licensing before charging money.
- **Unverified.** I haven't confirmed exactly how the MCP worker exposes registered functions as tools. Spike it before dropping our own `chamoji mcp`.

Design rule: **the deterministic path always works.** AI only suggests: it ranks, preselects and drafts. Code makes the decisions, and every AI result can be overridden with one keystroke. That is what keeps an open-source tool trusted, and it means it works offline and in CI with no API key.

## 4. The new idea: workstreams

**Problem:** branches are the only grouping git has, and they are the wrong unit. One branch often carries 3 unrelated changes. One feature often spans 4 PRs. Squash merges erase the internal structure. Changelogs then list commits ("fix typo", "address review") instead of things users care about ("New OAuth login").

**A workstream** is a named, long-lived unit of work: _"Auth revamp"_, _"Dark mode"_. It is recorded in git itself, so it travels with the history:

| Layer       | Mechanism                              | Why                                                                                                                                       |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Per commit  | Git trailer `Workstream: auth-revamp`  | Native git (`git log --format='%(trailers:key=Workstream)'`). It survives push and rebase, and GitHub's default squash message keeps it   |
| Retroactive | `git notes --ref=chamoji`              | Groups old or pushed commits without rewriting hashes (needs `refs/notes/chamoji` in push/fetch refspecs; `chamoji init` configures this) |
| Metadata    | `.chamoji/workstreams.yml` (committed) | Title, emoji, description, status (`active` / `shipped` / `dropped`), linked issues, owner                                                |
| Local state | `.git/chamoji/active` (not committed)  | The workstream you are "in" right now; the hook stamps it onto new commits                                                                |

**Developer flow**

```
chamoji ws start "Auth revamp" 🔐     # create + make active
git commit ...                        # hook adds `Workstream: auth-revamp`
chamoji ws switch dark-mode           # interleave work on the same branch, no stash dance
chamoji ws                            # board: each workstream, its commits across branches, unreleased count
chamoji ws ship auth-revamp           # mark shipped → becomes one changelog highlight
chamoji group --since v1.4.0          # AI-suggested grouping of ungrouped commits; review in TUI; written as notes
```

**Changelog effect:** a release renders **Highlights** (one entry per shipped workstream, with an optional AI-written summary and the commits folded underneath), followed by the usual emoji sections for loose commits. 40 commits become 5 readable lines.

It is lighter than stacked diffs (Graphite, Sapling) or a new VCS (Jujutsu). It needs no new branch model and no server. It is plain git metadata that any tool can read.

## 5. Where AI fits (Jev + an LLM)

Jev is a **judgment** model, not a text generator: it returns typed `choice` / `noul` / `score` answers with probabilities. It answers in about 100 ms and costs $0.042 per million input tokens (a 4k-token diff costs about $0.0002). That makes it fast and cheap enough to run on **every commit, inline in the prompt**. Prose generation goes to an optional LLM.

| Moment              | Judgment                                               | Primitive                                       | UX                                                                             |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `chamoji commit`    | Which gitmoji fits this staged diff + draft message?   | `choice` over ~75 gitmojis (limit 255)          | Picker opens with top 3 ranked; high confidence → preselected; Enter to accept |
|                     | Does this break a public API or behavior?              | `noul`                                          | Suggests 💥 + `BREAKING CHANGE:` footer; never auto-applies                    |
|                     | Which active workstream does this belong to?           | `choice` over open workstreams + `new` + `none` | Pre-fills the trailer                                                          |
|                     | Should this staged diff be 2+ commits?                 | `noul` per hunk pair ("same logical change?")   | Offers a split, clustered by code                                              |
|                     | Subject line text                                      | LLM (optional)                                  | Drafts from diff; user edits                                                   |
| `chamoji group`     | Which workstream does each ungrouped commit belong to? | `choice` per commit, run as a batch             | Low-confidence ones go to a review list                                        |
| `chamoji changelog` | How user-visible is this change?                       | `score` (internal → headline)                   | Hides noise (CI, typos) below a threshold you control                          |
|                     | Does the emoji disagree with the content?              | `choice` re-classification vs. the stated emoji | Lint warning, not an auto-fix                                                  |
|                     | Release summary per workstream                         | LLM (optional)                                  | Short paragraph under each Highlight                                           |

Implementation notes:

- JS SDK `@typesafe-ai/sdk` (needs Node 22+; today `engines` says `>=16`). One `client.systemOne({ state, questions })` call asks all commit-time questions in parallel, which is one round trip.
- State is structured JSON: `{ branch, stagedFiles, diff (truncated per file), draftMessage, activeWorkstreams, recentCommits }`.
- Thresholds start from the docs' defaults (noul ≥ 0.7 yes / ≤ 0.3 no, choice confidence ≥ 0.8 to preselect). Tune them on our own history: chamoji's own repo and the gitmoji repos are labeled data for free, since each emoji is a label.
- Privacy: diffs leave the machine only when AI is enabled. Use `--no-ai` / `ai: false` in config, plus a path denylist (`.env*`, secrets) that is stripped before sending.
- Provider interface (`Judge`, `Writer`) so the community can plug in local models.

## 5b. Project memory: commits that teach the AI

**Decided 2026-10-27:** v1 memory is **git-native only**: commit trailers, the `refs/chamoji/memory` ref, and a local index. Hosted cloud sync is a **paid tier later** (section 3b).

**Goal (from you):** every commit and workstream should leave behind context the project's AI can use later. Deleting a workspace or workstream must never lose that context. Memory should live locally and in the cloud, and stay small.

**Key call: store text as the source of truth, and treat vectors as a rebuildable cache.** Don't embed vectors or compressed blobs inside commit messages:

- Git keeps every byte forever, so blobs in commits _grow_ every clone and never shrink.
- Vectors are tied to one embedding model. When the model changes, every old commit holds garbage.
- They are unreadable, can't be diffed, and conflict badly on merge.
- A vector does not save disk space. A 1024-dim float32 vector is about 4 KB; the 300-byte text summary it came from is smaller. What vectors save is the AI's **context window**: it can retrieve 5 relevant cards instead of reading 5,000 commits.

**Design**

| Piece                      | What                                                                                                                                                                    | Where it lives                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intent card** per commit | 3–6 short lines: `Why`, `Constraint`, `Gotcha`, `Follow-up`, `Touches` (key files/symbols)                                                                              | Commit trailers (`Why: …`), so it travels with the commit even through squash merges                                                                                                            |
| **Workstream memory**      | Rolling summary: goal, decisions made, dead ends, open questions. It is updated when the workstream ships or is archived                                                | `refs/chamoji/memory`, a dedicated git ref (like git notes; GitButler and git-bug use custom refs too). Pushed and fetched with the repo, so every remote is "the cloud" with no extra infra    |
| **Archive, never delete**  | `chamoji ws drop` marks a workstream `dropped` and keeps its memory. Deleting a branch or worktree doesn't touch the ref                                                | Same ref. A hard delete requires an explicit `--purge`                                                                                                                                          |
| **Vector index**           | Embeddings of cards and workstream memory, int8-quantized, stamped with the model id                                                                                    | `.git/chamoji/index` (local, git-ignored, rebuilt with `chamoji memory reindex`). Built in the background by the iii daemon when it's running, otherwise on demand. Team sync = paid cloud tier |
| **Retrieval**              | Embedding/BM25 search → **Jev reranks** the candidates (`choice`/`noul` "is this relevant to the task?", per the TypeSafe rerank cookbook) → top-k cards                | Runs locally in about 100 ms                                                                                                                                                                    |
| **AI access**              | `chamoji mcp`: an MCP server with `search_memory`, `why <file:line>` (blame → cards), `workstream <id>`. Plus `chamoji memory digest > AGENTS.md` for tools without MCP | Claude Code, Cursor, etc. query the project's memory directly                                                                                                                                   |

**How cards get written, without slowing commits:**

- The composer asks one optional "why?" line.
- When an AI agent made the change, a hook lets the agent write the card from its own session. Claude Code hooks can do this at commit time.
- An LLM can compress a workstream's cards into its memory summary when it ships.
- Jev checks each card with a `noul` ("does this card state a reason, not just restate the diff?") and nudges when it doesn't.

**Honest limits:** an embedding is not "compressed memory": you can't reconstruct the text from it, so the text has to be kept somewhere. Keeping the text in git is what makes "nothing gets lost" true.

## 5c. Review packets: better human-in-the-loop review

**Problem:** Graphite and GitHub's stacked PRs make review _faster_ by splitting work into small PRs in review order. What they don't solve is _context_. The reviewer still chases the why across commits, tickets and chat. With AI agents writing more of the code, the reviewer often doesn't even know what the agent was asked to do.

**Idea:** for any workstream or commit range, chamoji assembles a **review packet**. It's a single page that brings the context to the reviewer. AI never approves anything; it decides _where the human's attention goes_.

| Section                   | Source                                                                               | How it's built                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Goal and decisions**    | Workstream metadata + `refs/chamoji/memory`                                          | Plain text, no AI                                                                       |
| **Per-commit intent**     | Intent-card trailers (`Why`, `Constraint`, `Gotcha`)                                 | Plain text; commits missing a why are flagged                                           |
| **Reading order**         | Commits grouped by the files and symbols they touch, not by time                     | Code (file overlap), optionally Jev to order clusters                                   |
| **Needs human eyes**      | Each hunk scored for review risk: auth, migrations, money, public API, deleted tests | Jev `score` + `noul` per hunk; boilerplate collapsed, risky hunks expanded              |
| **Claim check**           | Does the diff actually do what the commit's `Why` says?                              | Jev `noul` per claim (the citation-check pattern); mismatches flagged, never auto-fixed |
| **AI-authored work**      | Commits with an agent trailer, plus the agent's own session card                     | Shows what the human asked for next to what the agent did                               |
| **Since you last looked** | A per-reviewer watermark                                                             | Only new commits on a second pass                                                       |

**Feedback loop:** when a reviewer dismisses a flag or catches something the packet missed, that becomes labelled data. It tunes the thresholds on our own history; it doesn't retrain anything.

**Delivery:**

- `chamoji review <workstream|range>` writes Markdown or HTML.
- A GitHub Action posts the packet as one PR comment and updates it on each push.
- The same packet shows in the editor extension and the desktop app.

**Relationship to [Graphite](https://graphite.com)** (checked 2026-10-27):

- **What Graphite already does:**
  - Stacked PRs through its `gt` CLI and a [VS Code extension](https://graphite.com/docs/vs-code-extension), published to both the VS Code Marketplace and Open VSX.
  - A stack-aware merge queue.
  - **AI Reviews**, which flag bugs and suggest fixes on every PR.
  - **Graphite Chat**, which explains changes and applies fixes on the PR page.
  - Cursor Cloud Agents inside Graphite.
- **So "AI comments on the PR" is already taken.** Chamoji shouldn't compete there. Its edge is the part Graphite doesn't cover:
  - **Intent that lives in git.** Trailers and `refs/chamoji/memory` work with any host and survive squash merges. They don't depend on a platform.
  - **Workstreams span stacks.** A stack orders review; a workstream explains a goal across several stacks, PRs and releases, and flows into the changelog.
  - **Attention routing, not more comments.** The packet tells the human what to read first and what was claimed vs. done, rather than adding another reviewer voice.
  - **Free, open source and local-first.** It runs offline without an account.
- **Integration:** a packet should be able to follow a Graphite stack. Graphite's public pages don't document how stack metadata is stored or exposed, so that needs research in `gt`'s docs or source before milestone 6.

## 5d. Editor extension (VS Code, Cursor, Windsurf)

Yes, this belongs in the plan. The editor is where developers commit and review, so it's the highest-traffic surface after the CLI.

- **One extension, two registries.** Publish to the VS Code Marketplace _and_ [Open VSX](https://open-vsx.org), which is what Cursor, Windsurf and VSCodium install from. It's the same `.vsix`.
- **Same engine.** The extension is a thin UI over `@chamoji/core` (or the local iii daemon when it's running), so nothing is reimplemented.
- **Features, in order of value:**
  1. A commit helper in the Source Control panel: ranked gitmoji, the active workstream and a "why?" field, which fill the commit message box.
  2. A workstream sidebar with the active workstream in the status bar.
  3. A "why" hover on any line: blame → that commit's intent card and workstream.
  4. A review packet view for the current branch or PR.
- **Agents in Cursor and Claude Code** get the same context through `chamoji mcp`. The extension covers the human; MCP covers the agent.

## 6. GUI: Tauri 2 (recommended) vs Electron

**Recommendation: Tauri 2**, with the Node engine as a sidecar.

- Much smaller downloads: about 3–10 MB vs 85–244 MB. Memory savings are real but smaller and disputed (section 7), so don't oversell them.
- Precedent: GitButler, the most ambitious new git client, is Tauri.
- One engine: the desktop app talks to the local iii engine and the chamoji worker (section 3b) and subscribes to state changes for live updates. Tauri's official sidecar support ([Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/), `@yao-pkg/pkg`) bundles and starts the iii engine and the compiled worker, so users don't install anything separately. The UI is React, the same mental model as Ink, so components and state logic carry over. The CLI, GUI, and a future VS Code extension all use one JSON-RPC protocol.
- Cost: a thin Rust layer (window, sidecar, file dialogs) and WebKit on macOS/Linux instead of Chromium (test CSS on both).

**Pick Electron instead if** nobody on the team wants to touch Rust at all, or you need Node APIs directly in the main process. It is simpler to start, but heavier to ship.

**Sequencing:** CLI/TUI first (it is where commits happen), then `serve --stdio`, then the desktop app. The GUI's best screens are the ones a terminal does badly: the workstream board, drag-to-regroup commits, and a live changelog preview.

## 7. Market research findings

Checked against the GitHub API and npm on 2026-10-27. Items marked [unverified] were not checked against a primary source.

### How the gitmoji ecosystem works (what to reuse)

- **[carloscuesta/gitmoji](https://github.com/carloscuesta/gitmoji)** (16.8k★, active): a pnpm + Turborepo monorepo.
  - The canonical list is `packages/gitmojis/src/gitmojis.json`: 75 entries, validated by a JSON Schema (`emoji`, `entity`, `code`, `description`, `name`, `semver: major|minor|patch|null`).
  - It is published as the `gitmojis` npm package (v3.15.0, dual ESM/CJS) and served at `https://gitmoji.dev/api/gitmojis`.
  - The site itself is Next.js 16 + React 19.
  - **Reuse:** depend on `gitmojis` and drop our hand-copied map. Use its `semver` field for version bumps.
- **[gitmoji-cli](https://github.com/carloscuesta/gitmoji-cli)** (4.8k★, v9.7.0 May 2025, mostly Dependabot since):
  - Stack: meow, inquirer + autocomplete, fuse.js fuzzy search, execa.
  - Hook: `gitmoji -i` writes a `prepare-commit-msg` hook that re-attaches the terminal (`exec < /dev/tty`) and runs `npx gitmoji --hook`.
    - It skips amends, merges and rebases, and messages that already have an emoji.
    - Ctrl-C exits 0, so the commit is not cancelled.
  - Config: the `gitmoji` key in `package.json` or `.gitmojirc.json` (`autoAdd`, `emojiFormat`, `scopePrompt`, `messagePrompt`, `capitalizeTitle`, `gitmojisUrl`).
  - **Reuse:** copy the hook's edge-case rules exactly, and read `.gitmojirc` so existing users migrate for free.
  - **Modernize:** Ink instead of inquirer. Ranking that understands the diff, not fuzzy text search alone. The cache refreshes itself; gitmoji-cli only refreshes when you run `-u`, and detects new emojis by comparing list lengths.
- **[gitmoji-changelog](https://github.com/frinyvonnick/gitmoji-changelog)** (395★): **effectively unmaintained.** The last release was Jan 2022, the last push May 2024, and 50 issues are open.
  - Chamoji's current code is a port of it: same groups, same "first `:code:` in the subject" regex.
  - Its known gaps are our opening:
    - The commit body is never parsed (#258).
    - Merge commits leak into the changelog (#263).
    - No monorepo support (#158) or Cargo workspace support (#266).
    - No compare links (#153) and no GitHub Action (#143).
    - The mapping is stale, so newer gitmojis fall into Misc.
    - The `semver` field is ignored.
    - Its "group similar commits" option is Levenshtein string matching, not real grouping.

### What developers complain about

- **AI commit messages say _what_, not _why_.** The why lives in the developer's head or the ticket, not in the diff ([Finsland](https://steffenfinsland.substack.com/p/commit-messages-should-say-why-not), [Devin docs](https://docs.devin.ai/desktop/ai-commit-message.md) on big commits giving generic output).
  - **Chamoji answer:** ask one short "why?" prompt and put the workstream description into context. Jev picks; the developer writes the why.
- **Diff size limits.** Cursor caps commit generation at about 40K tokens and tells users to stage part of the change ([forum](https://forum.cursor.com/t/git-generate-commit-message-failing/158872)). aicommits forks hard-truncate diffs.
  - **Chamoji answer:** per-file summaries plus the "should this be split?" judgment turn the limit into a feature.
- **Cost and privacy of sending diffs to a cloud LLM** [unverified as a primary source, but commonly raised].
  - **Chamoji answer:** AI is off unless enabled, there is a path denylist, Jev costs fractions of a cent, and local models can plug in.
- **Changelogs built from commits are noise.** Dependency bumps and refactors drown out breaking changes ([agateau](https://agateau.com/2022/your-git-log-is-not-a-changelog/); arduino-lint [dropped its generated changelog](https://github.com/arduino/arduino-lint/pull/986) in Nov 2025 as worthless).
  - **Chamoji answer:** a user-visibility `score` plus workstream Highlights.
- **Squash vs. merge is a no-win choice.** Squashing loses structure and hurts bisect; not squashing leaves noise ([Cipriani](https://tylercipriani.com/archives/2020/10/), [QGIS thread, Aug 2026](https://lists.osgeo.org/pipermail/qgis-developer/2026-August/068501.html)).
  - **Chamoji answer:** workstream trailers survive squashing, so the structure lives above the commit.
- **Release tools are healthy but split.**
  - semantic-release (24k★) and release-please are commit-driven.
  - changesets (12.5k★) uses hand-written intent files.
  - git-cliff (12.3k★, Rust) uses regex parsers.
  - None of them understands gitmoji natively or uses AI judgments.
- **Grouping today means stacking.**
  - GitHub put stacked PRs and `gh stack` into [public preview on 2026-07-30](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/).
  - Graphite and Sapling have stacks; jj has stable change IDs plus community tools such as [jj-stack](https://www.serpentine.com/posts/2026/announcing-jj-stack/).
  - **The gap:** all of these organize _review order_. None gives a logical group of commits a name that carries through to the changelog. That is the workstream idea. It complements stacks rather than competing with them: a workstream can span several stacks.

### Tauri vs Electron, measured

- **Bundle size:** Tauri wins clearly, at about 3–10 MB vs 85–244 MB.
- **Memory and startup:** the gap is **smaller and disputed**. One test measured 109 MB vs 128 MB, and one startup benchmark had Tauri slightly slower ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)).
- **Node sidecars are officially documented** ([guide](https://v2.tauri.app/learn/sidecar-nodejs/)):
  - Compile with `@yao-pkg/pkg` and register the binary under `bundle.externalBin`.
  - Allowlist the permitted arguments in capabilities.
- **Precedent:**
  - [GitButler](https://github.com/gitbutlerapp/gitbutler) (21.9k★) is Tauri 2 with a Rust/gix backend.
  - [GitHub Desktop](https://github.com/desktop/desktop) is Electron with a bundled git (`dugite`).

## 8. Suggested first milestones

1. ✅ **Fix and restructure** (no AI): monorepo split, working `chamoji changelog` with full gitmoji list, trailers, tests on fixture repos. Published as `@chamoji/core` and `@chamoji/cli` 0.1.0.
2. **`chamoji commit`**: Ink composer + `prepare-commit-msg` hook; deterministic gitmoji search.
3. **Jev judgments** in the composer (gitmoji ranking, breaking-change check).
4. **Workstreams**: trailers + `.chamoji/workstreams.yml` + `ws` commands + Highlights in the changelog.
5. **Project memory**: intent-card trailers, `refs/chamoji/memory`, archive-not-delete, `chamoji mcp`.
6. **Review packets** (5c): `chamoji review` + GitHub Action PR comment. Deterministic sections first, then Jev risk scoring and claim checks.
7. **Editor extension** (5d): VS Code Marketplace + Open VSX (Cursor, Windsurf). Commit helper, workstream sidebar, "why" hover, packet view.
8. **`chamoji group`**: retroactive AI grouping with notes; local vector index + Jev rerank.
9. **iii spike, then `chamoji daemon`**: register the core functions through `iii-sdk`. Background indexing queue, state triggers, MCP worker. The extension and desktop app use it when it's running.
10. **Tauri desktop board** talking to the local iii engine.
11. **Paid cloud**: the same worker on hosted iii with database/storage workers for team memory sync and shared review packets.
