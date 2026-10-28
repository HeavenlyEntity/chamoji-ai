# Milestone 5: Jev in the Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the composer opens with the right gitmoji preselected, and flags commits that look breaking or mixed, from one fast Jev request. `changelog --ai` stops re-asking about commits it already sorted.

**Architecture:**

- **Staged changes in core:** `packages/core/src/staged.ts` reads the file list and line stats for what's staged. The diff text is read only when the user has opted in. A path denylist keeps secrets and lockfiles out of everything sent.
- **The commit advisor:** `packages/cli/src/advisor.ts` makes one System One request with three questions:
  - **gitmoji:** a Choice over the gitmoji list. The top three come from its `probabilities`.
  - **breaking:** a Noul, "Would this change break something people using the project rely on?"
  - **split:** a Noul, "Do the staged changes mix unrelated changes?"
- **The judgment cache:** `.git/chamoji/cache.json`, read and written by `packages/core/src/cache.ts`. It's keyed by commit hash and versioned by model and question set. `createJevClassifier` reads it before asking, and records every answer, including "none".
- **The composer:** it renders at once and receives the suggestion when it arrives. If the user hasn't typed a search yet, the top three gitmojis move to the head of the list, preselected. Breaking and split show as hints on their steps, and never as decisions. After 2 seconds without an answer, it carries on without one.
- **Settings in `chamoji.config.json`:** `"ai": {"composer": true, "sendDiffs": false}`. The key comes from `TYPESAFE_API_KEY`, or that line in `.env.local` or `.env`, as with `--ai`.

**Tech stack:** as milestone 4, plus `@typesafe-ai/sdk` 0.7 with `choice`, `noul`, and Choice `probabilities`.

**Spec:** `docs/ROADMAP.md`, milestone 5. The TypeSafe docs: Choice (the full `probabilities` distribution, up to 255 options), Noul (one yes/no per question; start at 0.7 for yes).

## Global constraints

- **Principle 1:** with no key, `ai.composer` off, or no network, the composer behaves exactly as in milestone 4.
- **Principle 2:** the gitmoji suggestion is a preselection the user can change in one keystroke. Breaking is a hint on the breaking step, never a pre-answered yes. Split is a hint only.
- **Principle 4:** by default only file paths, line counts and the draft title are sent.
  - The diff text is sent only with `ai.sendDiffs: true`, at most 200 lines per file and 2,000 in all.
  - Paths matching the denylist are never sent, not even their names: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*secret*`, and the lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `composer.lock`, `Gemfile.lock`).
  - The request says how many files were withheld.
- **The cache stores judgments only,** never commit text: `{gitmoji, confidence, model, version}` per hash.
- **Commits** use gitmoji and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A staged `.env.local` or private key.** Its path and content must never appear in the request. Covered in Task 2.
2. **A slow or failing API.** The composer must open at once and stay fully usable. A late answer must not move the list after the user has started typing. Covered in Task 5.
3. **A stale cache after the model or questions change.** Entries from another version are ignored. Covered in Task 1.
4. **A repository with thousands of commits and an empty cache.** The first `--ai` run fills the cache in batches as before, and the second sends nothing. Covered in Task 3.
5. **Breaking at 0.55.** That's uncertain, so no hint shows. The hint needs at least 0.7. Covered in Task 4.

---

### Task 1: The judgment cache

**Files:** create `packages/core/src/cache.ts`, and export it from `index.ts`. Test: `packages/core/test/cache.test.ts`.

**Interfaces:**

- `type Judgment = {gitmoji: string | null; confidence: number}`
- `openJudgmentCache(cwd: string, version: string): Promise<JudgmentCache>`
- `JudgmentCache` has `get(hash): Judgment | undefined`, `set(hash, judgment)` and `save(): Promise<void>`
- The file is `<git-dir>/chamoji/cache.json`, holding `{version, judgments: {[hash]: Judgment}}`.

- [ ] **Tests:**
  - get after set
  - save, then a fresh open, reads it back
  - a file with another version opens empty
  - a corrupt file opens empty and is replaced on save
  - the file holds no commit text
- [ ] **Commit** `✨ Cache Jev's judgments in .git/chamoji`

### Task 2: Staged changes

**Files:** create `packages/core/src/staged.ts`, and export it. Test: `packages/core/test/staged.test.ts`.

**Interfaces:**

- `readStagedChanges(cwd, {sendDiffs}): Promise<StagedChanges>`
- `type StagedChanges = {files: Array<{path; status: 'added' | 'modified' | 'deleted' | 'renamed'; added: number; deleted: number}>; withheld: number; diff?: string}`
- `isWithheld(path): boolean`

- [ ] **Tests** (fixture repos):
  - stats for an added and a modified file
  - a staged `.env.local`, `deploy/id_rsa` and `pnpm-lock.yaml` are absent, with `withheld: 3`
  - no `diff` unless `sendDiffs`
  - with `sendDiffs`, the diff covers only allowed files and respects the line caps
  - an unstaged change is not included
- [ ] **Commit** `✨ Read staged changes for the composer, withholding secrets`

### Task 3: The cache in `changelog --ai`

**Files:** modify `packages/cli/src/jev-classifier.ts` and `run.ts`. Test: `packages/cli/test/jev-classifier.test.ts`.

**Interfaces:** `createJevClassifier(client, {…, cache?: JudgmentCache})`. Commits with a cached judgment aren't sent. New answers, including `none` and low-confidence ones, are cached as they arrive. `run.ts` opens the cache when `--ai` is used, and saves it after the command.

- [ ] **Tests:**
  - a second classification of the same commits with a shared cache makes zero client calls and returns the same picks
  - a partly cached batch sends only the new commits
  - a failed request caches nothing for its commits
- [ ] **Commit** `⚡️ Don't ask Jev again about commits it already sorted`

### Task 4: The commit advisor

**Files:** create `packages/cli/src/advisor.ts`. Test: `packages/cli/test/advisor.test.ts`.

**Interfaces:**

- `createCommitAdvisor(client: AdvisorClient): (input: {staged: StagedChanges; draft?: string}) => Promise<Advice>`
- `type Advice = {gitmojis: Array<{code: string; probability: number}>; breaking: number; split: number}`. `gitmojis` holds the top three by probability, without `none`.
- `const HINT_THRESHOLD = 0.7`

The request is one `systemOne` call. Its state is `{files, withheldFiles, draftTitle, diff?}`, and its questions are `gitmoji` (choice), `breaking` (noul) and `split` (noul), each with a complete meaning in its instructions.

- [ ] **Tests** (fake client):
  - it's a single request with exactly those three questions
  - the state has no `diff` unless the input has one
  - the top three come from `probabilities` in order, skipping `none`
  - breaking and split pass through as numbers
  - a client error rejects, so the caller can carry on without advice
- [ ] **Commit** `✨ Ask Jev for gitmoji, breaking and split advice at commit time`

### Task 5: Advice in the composer

**Files:**

- Modify `packages/cli/src/composer.tsx`: an `advice?: Promise<Advice | null>` prop.
- Modify `run.ts`: build the advice for `commit` and `hook run` when `ai.composer` is on and there's a key.
- Modify `packages/core/src/config.ts`: the `ai` block of `chamoji.config.json`.

Tests: `composer.test.tsx` and `config.test.ts`.

- [ ] **Tests:**
  - advice that resolves before any typing puts its three gitmojis first, with the first selected and marked "suggested"
  - advice that resolves after typing doesn't move the list
  - breaking at 0.82 shows "Jev thinks this may be breaking" on the breaking step, and the default answer stays No
  - breaking at 0.55 shows nothing
  - split at 0.8 shows a hint on the title step
  - advice that rejects, or takes longer than 2 seconds, leaves the composer as it was
  - the config reads `ai.composer` and `ai.sendDiffs`, defaulting to false
- [ ] **Commit** `✨ Preselect Jev's gitmoji in the composer`

### Task 6: Measure and tune

**Files:** create `scripts/jev-eval.mjs`. Modify `docs/ROADMAP.md` and the readme.

- [ ] **The eval:**
  - For gitmoji and gitmoji-cli (from `.benchmarks/`), take 200 held-out commits that have a gitmoji.
  - Strip the gitmoji, and ask the advisor with each commit's file list and subject.
  - Report top-1 and top-3 accuracy, and p50 and p95 latency.
- [ ] **Exit criteria:**
  - top-3 at least 80%
  - p95 under 300 ms from a warm start
  - a second `changelog --ai` run on meow makes no requests
- [ ] **Tune** `minConfidence` from the eval's calibration if it shows a better cutoff.
- [ ] **Docs:** a readme section on composer AI, what's sent, and the opt-ins. The roadmap gets the numbers.
- [ ] **Commit** `📝 Measure Jev in the composer and document it`

### Later (not in this plan)

- **Prose drafts** of the title, from a pluggable model (Claude, or Ollama locally). The roadmap marks this optional, and it needs a separate opt-in.
