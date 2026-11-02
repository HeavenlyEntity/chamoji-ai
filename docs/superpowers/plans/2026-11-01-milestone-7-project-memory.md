# Milestone 7: Project Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person or an AI agent ask why a line of code is the way it is, and get the author's reasoning from git, even after the branch is gone.

**Architecture:** Intent cards are commit trailers, read by the existing parser. Workstream summaries are JSON files in a tree on `refs/chamoji/memory`, written with git plumbing so the working tree is never touched. A rebuildable BM25 index in the git directory serves search. `chamoji why`, `chamoji memory` and `chamoji mcp` are thin layers over those core functions.

**Tech Stack:** TypeScript (NodeNext), git plumbing, vitest, meow. No new runtime dependencies.

**Spec:** `docs/ROADMAP.md`, section "7. Project memory", plus the Principles section.

## Global Constraints

- **Trailer keys:** exactly `Why`, `Constraint`, `Gotcha`, `Follow-up`, matched case-insensitively.
- **Ref:** `refs/chamoji/memory`. Archive, never delete; `--purge` is needed for a hard delete.
- **Search:** BM25 first, rebuilt with `chamoji memory reindex`. Jev only reranks.
- **MCP tools:** exactly `search_memory`, `why` and `workstream`, all read-only.
- **Principle 1:** everything works offline with no API key, except `memory sync` and `init`, which talk to the user's own remote.
- **Principle 2:** AI only ranks. It never writes a card or changes one.
- **Principle 3:** memory lives in git and works with any host.
- **Principle 4:** only `--ai` sends anything to TypeSafe: the query plus each candidate's subject and card text. Never diffs or code, and never author emails.
- **No new runtime dependencies.** See Decisions.
- **Repo style:** prettier @vdemedes (tabs), NodeNext imports with `.js`, plain sentences in user-facing text.
- **Every commit in this milestone carries a `Why:` line** and is stamped `Workstream: project-memory`. That's the dogfooding.

## Decisions

These were tested on 2026-11-01 against a scratch remote, or measured.

| Decision                                                                             | Why                                                                                                                                                                                                                                                      | Cost if wrong                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The fetch refspec is the wildcard `+refs/chamoji/*:refs/chamoji/remotes/origin/*`    | An exact refspec makes every plain `git fetch` and `git pull` die with `couldn't find remote ref` until the remote has the ref. The wildcard doesn't                                                                                                     | None known                                          |
| **`init` does not set `remote.origin.push`. This departs from the roadmap**          | With that setting, plain `git push` pushed only the memory ref and left the branch behind. An explicit `git push origin main` ignored it anyway, so it wouldn't have saved memory for us. `chamoji memory sync` and `release --push` push memory instead | Someone must run `memory sync` to share memory      |
| Fetched memory lands in `refs/chamoji/remotes/origin/memory`, never on the local ref | A forced fetch onto the local ref would throw away local entries                                                                                                                                                                                         | None known                                          |
| `chamoji mcp` is a small hand-written stdio JSON-RPC server, not the MCP SDK         | The SDK installs 91 packages and 26 MB, doubling chamoji's 47 packages and 26 MB, and it brings express and hono for a transport we don't use. Three read-only tools need about five methods                                                             | We track protocol versions ourselves                |
| Embeddings are left out of this milestone                                            | The roadmap calls them optional, and a local model means a heavy dependency                                                                                                                                                                              | Search is keyword only                              |
| The agent hook covers Claude Code only                                               | It's what the exit criterion names. Cursor can follow                                                                                                                                                                                                    | Cursor users write cards by hand                    |
| The agent hook denies a commit with no card, instead of adding context               | Claude Code delivers `additionalContext` next to the tool result, after the commit exists. A denial reaches the agent while it can still write the card                                                                                                  | An agent retries once; `CHAMOJI_NO_CARD=1` opts out |
| The composer keeps its one `why` field                                               | Three more prompts would slow every commit. `git commit --trailer "Gotcha: …"` covers the rest                                                                                                                                                           | Cards from people stay mostly `Why:`                |

## Review Focus

1. Plain `git fetch` and `git pull` after `chamoji init`, on a remote with no memory yet: both must keep working. (Task 4)
2. Plain `git push` after `chamoji init`: the current branch must still reach the remote. (Task 4)
3. Two clones ship different workstreams, then both sync: both entries must survive, in either order. (Task 4)
4. `chamoji why` on an uncommitted line, a line past the end, a missing file, or a path containing a colon: a plain message and exit 1, never a raw git error. (Task 2)
5. A corrupt memory entry or index under `chamoji mcp`: that call returns a tool error, the server stays up, and stdout carries only JSON-RPC. (Task 6)

---

## Setup (controller, before Task 1)

- [ ] Create the worktree from `main` with the app's worktree tool, named `milestone-7`. Move this plan into it, then `pnpm install --frozen-lockfile && pnpm build`.
- [ ] Run `node packages/cli/dist/cli.js hook install`, then `node packages/cli/dist/cli.js ws start "Project memory" 🧠`.
- [ ] Commit the plan and `.chamoji/workstreams.yml` with `git commit -m`. Check the commit carries `Workstream: project-memory`.

### Task 1: Intent cards

**Files:**

- Create: `packages/core/src/intent.ts`, `packages/core/test/intent.test.ts`
- Modify: `packages/core/src/types.ts`, `packages/core/src/parse.ts`, `packages/core/src/index.ts`, `packages/core/test/parse.test.ts`

**Interfaces:**

- Produces: `type IntentCard = {why: string[]; constraint: string[]; gotcha: string[]; followUp: string[]}`
- Produces: `readIntent(trailers: Trailer[], body: string): IntentCard | undefined`, undefined when every list is empty
- Produces: `ParsedCommit.card?: IntentCard`, absent when the commit has none, following the `withWorkstream` pattern

- [ ] **Step 1: Write the failing tests** in `intent.test.ts`:
  - `reads all four keys`: trailers for each key give `{why: ['a'], constraint: ['b'], gotcha: ['c'], followUp: ['d']}`
  - `matches keys in any case`: `WHY: a` and `follow-up: d` are read
  - `keeps several values in order`: two `Gotcha:` lines give `gotcha: ['x', 'y']`
  - `reads lines from a GitHub squash body`: for a body shaped like `* Add login`, blank, `Why: a`, blank, `* Fix it`, blank, `Why: b`, blank, `---------`, blank, `Co-authored-by: Dev <d@e.f>`, `why` is `['a', 'b']`
  - `drops repeats between trailers and body`: `Why: a` in both gives `['a']`
  - `ignores empty values and prose`: `Why:` with no value, and `Why this works: x`, give `undefined`

  In `parse.test.ts`: `a commit with no card has no card key`, using `expect('card' in commit).toBe(false)`; and `a revert keeps no card from the commit it reverts`.

- [ ] **Step 2: Run them and watch them fail.** Run: `pnpm exec vitest run packages/core/test/intent.test.ts packages/core/test/parse.test.ts`
- [ ] **Step 3: Implement `readIntent`.** Read parsed trailers first, then scan the body with `/^(why|constraint|gotcha|follow-up):[ \t]+(\S.*)$/im`, and dedupe. Wire it into `parseCommit`.
- [ ] **Step 4: Confirm the rest of the output is unchanged.** Run: `pnpm test`. Expected: all pass, with Markdown and HTML changelog tests untouched. Cards never appear in rendered changelogs.
- [ ] **Step 5: Commit.**

### Task 2: `chamoji why`

**Files:**

- Create: `packages/core/src/blame.ts`, `packages/core/test/blame.test.ts`, `packages/cli/src/why.ts`, `packages/cli/test/why.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/run.ts`, `packages/cli/src/ws.ts`

**Interfaces:**

- Consumes: `ParsedCommit.card` from Task 1
- Produces: `blameLine(cwd: string, file: string, line: number): Promise<BlameResult>`, where `type BlameResult = {kind: 'commit'; commit: ParsedCommit} | {kind: 'uncommitted'}`
- Produces: `class WhyError extends Error`, with a user-readable message
- Produces: `parseLocation(input: string): {file: string; line: number}`, which splits at the last colon
- Produces: `runWhy(input: string[], flags: {json?: boolean}, io: Io): Promise<number>`
- Produces: exported `stripControl(text: string): string`, moved from `ws.ts`

- [ ] **Step 1: Write the failing tests:**
  - `finds the commit that wrote a line`: its `card.why` is `['because']`
  - `follows a line through a rename`
  - `reports an uncommitted line`: `kind` is `'uncommitted'`
  - `a line past the end throws WhyError` with message `src/a.ts has 3 lines`
  - `a missing file throws WhyError` with message `No such file in HEAD: nope.ts`
  - `parseLocation splits at the last colon`: `a:b.ts:12` gives `{file: 'a:b.ts', line: 12}`
  - `parseLocation refuses a bad location`: `a.ts`, `a.ts:0` and `a.ts:x` throw WhyError
  - `a file name starting with a dash is treated as a file`
  - CLI: `prints the commit and its card`; `a commit with no card still prints its subject and says so`, exit 0; `--json prints the BlameResult`; `strips terminal escapes from commit text`; `outside a repo reports it plainly`, exit 1

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Use `git blame --porcelain -w -M -L <n>,<n> HEAD -- <file>`, map git's errors to WhyError, and treat an all-zero hash as uncommitted. Read the commit with `readCommits` and `parseCommit`. Add the `why` case and help text to `run.ts`.
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Commit.**

### Task 3: The memory ref

**Files:**

- Create: `packages/core/src/memory.ts`, `packages/core/test/memory.test.ts`, `packages/cli/src/memory.ts`, `packages/cli/test/memory.test.ts`
- Modify: `packages/core/src/git.ts`, `packages/core/src/index.ts`, `packages/cli/src/ws.ts`, `packages/cli/src/run.ts`, `packages/cli/src/why.ts`, `packages/cli/test/ws.test.ts`, `packages/cli/test/why.test.ts`

**Interfaces:**

- Consumes: `IntentCard`, `Workstream`, `isSlug`, `readWorkstreams`
- Produces: `MEMORY_REF = 'refs/chamoji/memory'`
- Produces: `runGitWithInput(args: string[], cwd: string, input: string): Promise<string>` in `git.ts`
- Produces: `type MemoryCommit = {hash: string; subject: string; date: string; card?: IntentCard}`
- Produces: `type MemoryEntry = {version: 1; slug: string; title: string; emoji?: string; status: WorkstreamStatus; updatedAt: string; archived: boolean; commits: MemoryCommit[]}`
- Produces: `listMemory(cwd: string, options?: {archived?: boolean}): Promise<MemoryEntry[]>`
- Produces: `readMemory(cwd: string, slug: string): Promise<MemoryEntry | undefined>`
- Produces: `snapshotWorkstream(cwd: string, slug: string): Promise<MemoryEntry>`
- Produces: `archiveMemory(cwd: string, slug: string): Promise<void>` and `purgeMemory(cwd: string, slug: string): Promise<void>`
- Produces: `class MemoryError extends Error`
- Produces: `readTree(cwd: string, commit: string): Promise<Map<string, string>>` and `writeTree(cwd: string, entries: Map<string, string>, parents: string[], message: string): Promise<string>`, for Task 4

**Layout on the ref:** `workstreams/<slug>.json`, `archive/<slug>.json`, and an empty `purged/<slug>` tombstone. Each commit on the ref uses the fixed identity `chamoji <noreply@chamoji.dev>`, passed with `-c user.name` and `-c user.email`, so it works with no git identity and records no email.

- [ ] **Step 1: Write the failing tests:**
  - `a snapshot holds the commits that name the workstream`: 2 of 3 commits, with cards
  - `a snapshot leaves the work tree, the index and HEAD alone`: `git status --porcelain` is the same before and after
  - `a later snapshot keeps commits it can no longer reach`: union by hash after the branch is reset
  - `works with no git identity set`
  - `the ref records no author email`
  - `an entry that isn't valid JSON is skipped by listMemory` and throws MemoryError from `readMemory`
  - `a slug that fails isSlug is refused`, and `a tree path that isn't a slug is ignored on read`
  - `archive moves the entry and keeps its content`: `listMemory` hides it, `{archived: true}` shows it, and `readMemory` still returns it with `archived: true`
  - `snapshot of an archived slug brings it back`
  - `purge leaves no trace in the ref's history`: `git log --all -p refs/chamoji/memory` has no entry text, and the tombstone exists
  - `purge refuses a slug that doesn't exist`
  - `update-ref is compare-and-swap`: a moved ref makes the write retry once and keep both entries
  - CLI: `ws ship writes a snapshot`; `ws drop writes a snapshot`; `a failed snapshot warns and ws ship still succeeds`; `memory list`; `memory show <slug>`, with `--json`; `memory archive <slug>`; `memory archive <slug> --purge sends the user to memory sync, not to a raw force-push`
  - `why falls back to the workstream summary`: a commit with no card but a `Workstream:` line prints that workstream's title

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement the core.** Use `ls-tree -r` to read and `hash-object -w --stdin`, `mktree` and `commit-tree` to write, with `update-ref <ref> <new> <old>`. Purge writes a new root commit with no parents. Never run `checkout` or touch the index.
- [ ] **Step 4: Implement the CLI.** Add `runMemory(input, flags, io)` with `list`, `show` and `archive`, a `purge` flag in `run.ts`, and the snapshot calls in `ws ship` and `ws drop`. Keep ws's promise of no network.
- [ ] **Step 5: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 6: Commit.**

### Task 4: `chamoji init` and `memory sync`

**Files:**

- Create: `packages/core/src/memory-sync.ts`, `packages/core/test/memory-sync.test.ts`, `packages/cli/src/init.ts`, `packages/cli/test/init.test.ts`
- Create: `packages/cli/test/memory-e2e.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/memory.ts`, `packages/cli/src/run.ts`

**Interfaces:**

- Consumes: `readTree`, `writeTree`, `MEMORY_REF` from Task 3
- Produces: `MEMORY_FETCH_REFSPEC = '+refs/chamoji/*:refs/chamoji/remotes/origin/*'`
- Produces: `MEMORY_REMOTE_REF = 'refs/chamoji/remotes/origin/memory'`
- Produces: `syncMemory(cwd: string): Promise<SyncResult>`, where `type SyncResult = {fetched: boolean; merged: boolean; pushed: boolean; entries: number}`
- Produces: `mergeTrees(ours: Map<string, string>, theirs: Map<string, string>, read: (blob: string) => Promise<string>): Promise<Map<string, string>>`
- Produces: `runInit(flags: {agents?: boolean}, io: Io): Promise<number>`. Task 7 adds `--agents`.

**Merge rules:** the union of paths. For a slug in both, the newer `updatedAt` wins. An `archive/` entry beats a `workstreams/` entry unless the live entry's `updatedAt` is newer. A `purged/` tombstone removes that slug from both.

- [ ] **Step 1: Write the failing tests**, using a real bare repo as the remote:
  - `init adds the wildcard fetch refspec once`: running it twice leaves one line in `git config --get-all remote.origin.fetch`
  - `init leaves remote.origin.push unset`
  - `plain git fetch and git pull work after init on a remote with no memory`
  - `plain git push still pushes the branch after init`
  - `init with no origin says so and exits 0`
  - `sync pushes local memory to an empty remote`
  - `sync takes remote memory into a clone that has none`
  - `sync fast-forwards when one side is behind`
  - `two clones ship different workstreams and both sync, in either order`: both entries are in the final tree
  - `the newer entry wins when both changed the same slug`
  - `a tombstone stops a purged entry coming back`
  - `sync retries once when a push loses a race`
  - `sync with no origin throws MemoryError` with message `No remote named origin`
  - `release --push syncs memory, and a failed sync doesn't fail the release`
  - **Exit criterion, in `memory-e2e.test.ts`:** on a branch, commit with a `Why:` line, `ws ship`, `memory sync`. Delete the branch unmerged, then run `git reflog expire --expire=now --all && git gc --prune=now`. `memory show` still prints the `Why:` text. Then `git clone` from the remote, run `chamoji init`, and `memory show` prints it there too.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Fetch with the wildcard refspec on the command line so a missing remote ref is not an error. Merge with `writeTree` and two parents. Push only `refs/chamoji/memory:refs/chamoji/memory`.
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Commit.**

### Task 5: Search

**Files:**

- Create: `packages/core/src/bm25.ts`, `packages/core/test/bm25.test.ts`, `packages/core/src/memory-index.ts`, `packages/core/test/memory-index.test.ts`, `packages/cli/src/rerank.ts`, `packages/cli/test/rerank.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/memory.ts`, `packages/cli/src/run.ts`, `scripts/benchmark.mjs`

**Interfaces:**

- Consumes: `readCommits`, `parseCommit`, `listMemory`
- Produces: `tokenize(text: string): string[]`, lowercased, split on anything that isn't a Unicode letter or number
- Produces: `buildIndex(documents: SearchDocument[]): Bm25Index` and `queryIndex(index: Bm25Index, query: string, limit: number): Array<{id: string; score: number}>`, with `k1 = 1.2` and `b = 0.75`
- Produces: `type SearchDocument = {id: string; fields: Array<{text: string; weight: number}>}`
- Produces: `type MemoryHit = {kind: 'commit' | 'workstream'; id: string; title: string; card?: IntentCard; score: number}`
- Produces: `reindexMemory(cwd: string): Promise<{documents: number}>`
- Produces: `searchMemory(cwd: string, query: string, options?: {limit?: number}): Promise<MemoryHit[]>`, default limit 10
- Produces: `type MemoryReranker = (query: string, hits: MemoryHit[]) => Promise<MemoryHit[]>`
- Produces: `type RerankClient`, the slice of the TypeSafe client this file uses, and `jevReranker(client: RerankClient): MemoryReranker`

**Index:** `<git-dir>/chamoji/memory-index.json`, holding its format version, the HEAD hash and the memory ref hash it was built from. `searchMemory` rebuilds it when any of those differ. It indexes every commit on HEAD plus every live entry: card text weighs 3, subject 2 and body 1.

- [ ] **Step 1: Write the failing tests:**
  - `bm25 ranks a rarer term higher`, and `shorter documents score higher for the same term`
  - `a field weight changes the order`
  - `an empty query gives no results`
  - `tokenize keeps non-Latin words`: `日本語のコミット` stays as tokens
  - `search finds a Why: line that isn't in the subject`
  - `a card match outranks a body match`
  - `search finds a workstream summary whose branch is gone`
  - `a new commit rebuilds the index on the next search`
  - `a corrupt index file is rebuilt, not fatal`
  - `the rerank keeps the hit list and only changes its order`
  - `a failed rerank returns the BM25 order` and prints one stderr note
  - `the rerank request holds no email and no diff`: inspect what the fake client received
  - CLI: `memory search <query>`, with `--json`; `memory reindex` prints the count; `--ai with no key says so and exits 2`

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement BM25 and the index.**
- [ ] **Step 4: Implement the rerank.** Read the live TypeSafe docs for the Score primitive first. Send one Score question per candidate (at most 10), with 300 characters of its subject and card text. Leave the classifier's `JevClient` type alone.
- [ ] **Step 5: Measure.** Add index build and search timings to `scripts/benchmark.mjs`. **Target:** build in under 5 s and search in under 300 ms on Vite's 8,685 commits. Record the real numbers in this plan's Results section.
- [ ] **Step 6: Run the tests and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 7: Commit.**

### Task 6: `chamoji mcp`

**Files:**

- Create: `packages/cli/src/mcp.ts`, `packages/cli/test/mcp.test.ts`
- Modify: `packages/cli/src/run.ts`

**Interfaces:**

- Consumes: `blameLine`, `searchMemory`, `readMemory`, `listMemory`, `readWorkstreams`, `getActive`, `jevReranker`
- Produces: `runMcp(flags: {ai?: boolean}, io: Io & {stdin: NodeJS.ReadableStream}): Promise<number>`, which resolves when stdin ends
- Produces: `handleMessage(line: string, tools: McpTools): Promise<string | undefined>`, undefined for notifications

**Protocol:** newline-delimited JSON-RPC 2.0 over stdio. Handle `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`; anything else returns `-32601`. On `initialize`, echo the client's `protocolVersion` when it's one of `2025-11-25`, `2025-06-18`, `2025-03-26` or `2024-11-05`, else answer `2025-11-25`.

**Tools:**

- `search_memory`: `{query: string, limit?: number}`
- `why`: `{file: string, line: number}`
- `workstream`: `{slug?: string}`. With no slug, it gives the active workstream, or the list when none is active.

- [ ] **Step 1: Write the failing tests:**
  - `initialize echoes a known protocol version`, and `answers the latest for an unknown one`
  - `tools/list names exactly three tools`
  - `each tool returns its data as text content`
  - `an unknown method returns -32601`, `bad JSON returns -32700`, and `a notification gets no reply`
  - `a corrupt memory entry gives isError true and the server keeps answering`
  - `a path outside the repo gives isError true`
  - `stdout carries only JSON-RPC`: spawn the built CLI, send three requests, and `JSON.parse` every stdout line
  - `--ai with no key warns on stderr and stays on BM25`

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Handle requests one at a time in order, and write logs only to stderr.
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Exit criterion, with the real client.** Run `claude mcp add chamoji-dev -- node <worktree>/packages/cli/dist/cli.js mcp`, then ask Claude Code why a specific line in `packages/core/src/parse.ts` is the way it is. Expected: it calls `why`, and its answer quotes the card or commit. Remove the server afterwards. Record the result.
- [ ] **Step 6: Commit.**

### Task 7: The agent hook

**Files:**

- Create: `packages/cli/src/agent-hook.ts`, `packages/cli/test/agent-hook.test.ts`
- Modify: `packages/cli/src/init.ts`, `packages/cli/test/init.test.ts`, `packages/cli/src/run.ts`

**Interfaces:**

- Consumes: Claude Code's `PreToolUse` input, reading `tool_name` and `tool_input.command`
- Produces: `decideCommit(command: string): 'allow' | 'deny'`
- Produces: `runAgentHook(io: Io & {stdin: NodeJS.ReadableStream}): Promise<number>`, which always exits 0
- Produces: `chamoji init --agents`, which merges into `.mcp.json` and `.claude/settings.json`

**Denial reason, exact copy:** `Add why this change was made: put a "Why: <reason>" line at the end of the commit message, after a blank line. Constraint:, Gotcha: and Follow-up: lines are welcome too. For a trivial change, prefix the command with CHAMOJI_NO_CARD=1.`

The settings entry uses `matcher: "Bash"` and `if: "Bash(git commit *)"`, with the command `chamoji agent-hook` when chamoji is on PATH at init and `npx --yes @chamoji/cli agent-hook` otherwise. Denying prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` to stdout. Allowing prints nothing.

- [ ] **Step 1: Write the failing tests:**
  - `decideCommit` table: `git commit -m "x"` denies; `git commit -m "x\n\nWhy: y"` allows; a heredoc holding `Constraint: y` allows; `git add . && git commit -m x` denies; `git -C repo commit -m x` denies; `git commit --amend --no-edit` allows; `git commit -F msg.txt` allows; `git commit --fixup HEAD` allows; `git log --grep commit` allows; `echo git commit` allows; `CHAMOJI_NO_CARD=1 git commit -m x` allows
  - `bad JSON on stdin prints nothing and exits 0`, and `a tool other than Bash prints nothing`
  - `init --agents adds chamoji to an existing .mcp.json and keeps other servers`
  - `init --agents keeps existing settings and hooks`
  - `init --agents twice adds nothing new`
  - `init --agents refuses a corrupt settings file` and leaves it untouched
  - `plain init writes neither file`

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Try it for real.** Run `chamoji init --agents` in a scratch repo, then have Claude Code commit there without a `Why:` line. Expected: the first attempt is denied, and the retry carries a card.
- [ ] **Step 6: Commit.**

### Task 8: Docs and the record

**Files:**

- Modify: `readme.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Document it in the readme.** Add a Project memory section covering the four trailers, including `git commit --trailer`; `chamoji why`; `memory` and its subcommands; `init` and why it leaves `git push` alone; `mcp` setup for Claude Code; and the agent hook with its opt-out. Add what `--ai` sends to the existing list of what leaves the machine. Explain that a squash with "Pull request title" or "title and description" drops cards from the commit, and that the summary on the memory ref keeps them.
- [ ] **Step 2: Update the roadmap.** Set milestone 7 to `🚧 Built, release pending` with this plan's link. Add results for both exit criteria, the Task 5 numbers, the two criteria's real-client runs, and the `remote.origin.push` departure. Add a new row to "Repos using it".
- [ ] **Step 3: Check it all.** Run: `pnpm build && pnpm test && pnpm exec prettier --check .github scripts readme.md docs packages && pnpm exec tsc -p tsconfig.test.json`
- [ ] **Step 4: Check the dogfooding.** `git log main..HEAD --format=%H` and `git log main..HEAD --format=%B | grep -c '^Workstream: project-memory'` give the same count, and `git log main..HEAD --format=%B | grep -c '^Why: '` is at least that many less the plan commit.
- [ ] **Step 5: Commit.** Do not run `ws ship` or `memory sync` yet. Those wait for the sprint of real use the roadmap requires, so they happen just before release.

## Results

**Status (2026-11-01):** built on the `worktree-milestone-7` branch, not released. The roadmap requires a sprint of real use before the milestone is done, and that has not happened. `chamoji ws ship` and `chamoji memory sync` for `project-memory` wait until just before release.

### Exit criteria

- ✅ **Claude Code answers "why is this line like this?" through `chamoji mcp` on chamoji's own repo: passed.** `claude -p` on haiku, started with `--mcp-config` and `--strict-mcp-config` in this worktree, called `mcp__chamoji__why` on `packages/core/src/intent.ts:3` and quoted the card from commit 83329f3. The user's own Claude Code config was not touched.
- ✅ **Memory survives deleting a branch and a fresh clone: passed.** `packages/cli/test/memory-e2e.test.ts` runs it through the built CLI against a local bare remote. It has not run against GitHub.

### Search numbers (Task 5)

Vite at 9,776 documents (the plan assumed 8,685 commits; the clone has grown). Both figures are whole CLI runs, from `node scripts/benchmark.mjs --search vitejs/vite`.

| Measure     | Result               | Target       |
| ----------- | -------------------- | ------------ |
| Index build | 0.47 s               | under 5 s    |
| Search      | 228 ms (median of 5) | under 300 ms |
| Index size  | 2.5 MB               |              |

Node start-up alone is about 170 ms of the search figure, so the search itself is about 60 ms. The margin to the target is thin for that reason, not because of the index.

### Real-client runs

- **MCP server:** the exit criterion 1 run above, with the server loaded through `--mcp-config`. A server declared in a project `.mcp.json` shows "Pending approval" in `claude mcp list` until the user approves it, so the readme says to approve it. That path was not approved in the check, so a connection through `.mcp.json` itself is unverified. The same server connected through `--mcp-config`.
- **Agent hook:** run against real Claude Code (haiku) in a scratch repo. A plain `git commit -am` and a compound `git add -A && git commit -m` were denied, a retry carried a `Why:` line, and `CHAMOJI_NO_CARD=1` committed on the first try. The run also showed haiku taking the opt-out on its first denial, because the first denial text invited it ("For a trivial change, prefix the command with CHAMOJI_NO_CARD=1"). The text now says to opt out only if the user said to skip the card.

### Departures from the plan and the roadmap

- **No `remote.origin.push`.** The roadmap's `chamoji init` was to configure push and fetch refspecs. Setting `remote.origin.push` made a plain `git push` push only the memory ref and leave the branch behind, and an explicit `git push origin main` ignored it anyway. `init` sets only the fetch line. Memory goes out through `chamoji memory sync` and `chamoji release --push`, the latter only in a clone that ran `init`.
- **`chamoji why` on an uncommitted line exits 0,** where Review Focus 4 said exit 1. "Not committed yet" is an answer. A missing file or a line past the end still exits 1.
- **Embeddings are left out.** The roadmap calls them optional. Search is BM25 with an optional Jev rerank.
- **The MCP server has no SDK.** It is a small hand-written stdio JSON-RPC server, as decided in the plan.
- **The agent hook covers Claude Code only.**
- **Added beyond the plan** (rulings in the ledger): a merge never reaches purged text; `init` also takes in remote memory; `release --push` syncs memory only in a clone that ran `init`; commit records are framed with NUL so commit text can't forge them; the hook command ends in `|| true`; the denial text differs from the plan's exact copy.

### Things to know

- **Purge and the remote:** `memory archive --purge` removes an entry locally and deletes this worktree's search index, which held its text. Removing it from the remote goes through `chamoji memory sync`, which merges origin's memory first and then prints the force-push to run, with a warning that it replaces origin's history. An earlier version printed the raw force-push straight after the purge, and following it could erase a teammate's unsynced entry from origin. Any clone that already fetched the entry still holds the text. The tombstone keeps the slug, and so does the `Purge <slug>` commit message, so purging removes the content and not the name; a purged slug can't be saved again.
- **Older clients drop what they don't know.** A write or merge keeps only the paths and file modes this version reads. A future memory format needs its own ref or a version bump; adding folders to `refs/chamoji/memory` would be stripped by released clients.
- **Plain `git fetch` and `git pull`** download origin's memory into the side ref but don't change what `chamoji memory` shows. `chamoji memory sync` brings it in.
- **A memory ref is shared with anyone who can push to the repo.** Entries from origin are data. A pusher can add or retitle them, and cards are never verified.
- **Final-wave fixes** (in the commit before the docs commit): `why.body` scans at most twice its cap before the reply cut, `init --agents` writes its temp file as 0600 and sets the final mode without setuid bits, and the hook's denial text no longer invites the opt-out.
- **Final whole-branch review fixes:** purge sends the user to `memory sync` instead of printing a raw force-push; the Windows-unsafe `init` tests are skipped there; `redact` caps the local part of an address and the rerank cuts a candidate's text before redacting; `memory sync` retries only a rejected push, so a pre-push hook that refuses it runs once and is reported; `ws ship` and `ws drop` say how many commits they saved to memory; `memory list --archived` and a notice for unreadable entries; the purged-slug error names the remedy; purge deletes this worktree's search index; the agent hook reads a card the way the parser does (the subject paragraph is never a card, indentation and CRLF line endings are fine, `Why:nospace` counts as git's trailer form); `stripControl` also strips bidirectional overrides and line separators.

### Not verified

- fish, pwsh and Windows for the new commands. CI has not run on this branch.
- A real push of the memory ref to GitHub. The e2e test uses a local bare remote.
- `.mcp.json` approval flow end to end in Claude Code (see above).
- The `.mcp.json` that `init --agents` writes on native Windows, where `npx` and a `chamoji` shim may need a `cmd /c` wrapper.
- The `--ai` rerank has never run against the real TypeSafe API. Its tests use a fake client. On any failure it falls back to the BM25 order with a note.

### Counts

At the end of Task 8 the suite had 1010 tests, up from the 570 baseline at the plan commit.
