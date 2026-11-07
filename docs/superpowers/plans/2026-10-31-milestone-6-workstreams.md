# Milestone 6: Workstreams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a release reads as the features it shipped, not a list of commits. Commits carry a `Workstream:` trailer, and each shipped workstream becomes one Highlights entry with its commits folded underneath.

**Architecture:**

- **The record lives in git.** The `Workstream:` trailer is on each commit. `.chamoji/workstreams.yml` is committed and holds the metadata. `.git/chamoji/active` is local and says which workstream you're in.
- **`packages/core/src/workstreams.ts`** owns the slug rules, the file, the active state and stamping. `chamoji ws` in the CLI is a thin layer over it.
- **`buildChangelog` reads the file as of each release.** Tag `v1.2.0` uses `git show v1.2.0:.chamoji/workstreams.yml`, so shipping a workstream today never rewrites an older release. Unreleased commits use the file at `to`.
- **Highlights are added to `Release` only when there are some.** A repo that doesn't use workstreams gets byte-identical output.

**Tech stack:** as milestone 5, plus [`yaml`](https://www.npmjs.com/package/yaml) ^2 in `@chamoji/core`. It has no dependencies, and its `Document` API keeps comments when a command rewrites the file.

**Spec:** `docs/ROADMAP.md`, milestone 6. Background: `docs/research/2026-10-27-chamoji-direction.md`, section 4.

**Out of scope:** the retroactive `git notes` layer and `chamoji group` (milestone 9), AI-written summaries, owners, and a board across branches. `ws list` counts commits on the current branch only.

## Global constraints

- **Principle 1:** everything works offline with no API key. No workstream command makes a network call.
- **Principle 3:** context lives in git, in trailers and a committed file, with no host lock-in.
- **A repo with no `.chamoji/workstreams.yml` gets exactly today's output** in every format, and today's commit messages.
- **The hook never blocks a commit.** Any stamping failure is swallowed the way `runHook` already does: `chamoji: hook skipped (...)`, exit 0.
- **An author's words win.** A message that already has a `Workstream:` trailer keeps it.
- **Slugs match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, at most 64 characters.** Anything else is treated as no workstream. This is also what stops a newline in `.git/chamoji/active` reaching a commit message.
- **Text from the file is untrusted,** since it can arrive in anyone's PR. Titles, emoji and descriptions go through `escapeMarkdown` and `escapeHtml`.
- **Commits** use gitmoji and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions

These are the calls the roadmap leaves open. Change them here, not mid-task.

| Question                                    | Decision                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which commits become a highlight?           | Those whose workstream has `status: shipped` in the file as of that release. Active, dropped and unknown slugs stay loose.                                              |
| A workstream spans two releases?            | Its commits in the earlier release stay loose, because it wasn't shipped at that tag. The release it ships in gets the entry. History doesn't change.                   |
| A breaking commit inside a workstream?      | It stays under Breaking changes and isn't folded away. Readers must not need to expand anything to find it.                                                             |
| Commits in hidden groups (release commits)? | They stay hidden. A workstream with only hidden commits gets no entry.                                                                                                  |
| Does `ws ship` commit?                      | No. `ws start`, `ship` and `drop` write the file and `git add` it, then say so. The change lands in your next commit. chamoji only makes commits in `chamoji release`.  |
| Are `links` rendered?                       | Stored, and shown in `ws list --json` and the changelog's JSON. Not rendered in Markdown or HTML in this milestone.                                                     |
| Reading the trailer                         | `%(trailers)` first, then any `Workstream: <slug>` line in the body. GitHub's squash message puts trailers mid-body, and git only parses the last paragraph (verified). |
| A squash that mixes workstreams?            | The commit gets the first one found. Documented as a limit.                                                                                                             |
| Which sources does the hook stamp?          | None, `message` and `template`. Not `merge`, `squash` or `commit` (amend), and not during a rebase, cherry-pick or revert: those commits already say what they are.     |
| Worktrees                                   | Active state uses `--absolute-git-dir`, as the judgment cache does, so each worktree has its own.                                                                       |
| The file can't be parsed                    | `ws` commands refuse and change nothing. At `to`, `buildChangelog` throws a clear error. At an older tag it's ignored, so one bad old commit can't break every build.   |

## Review focus

1. **`git commit -m "..."` with an active workstream.** `shouldPrompt` says no, so the hook returns early today. The stamp must still happen. Covered in Task 5.
2. **A repo already using chamoji, no workstreams.** All output is unchanged. Covered in Task 3 and by the existing suites.
3. **An active workstream that was shipped on another branch, or deleted from the file.** Commits go through unstamped, with no error. Covered in Task 1.
4. **`repoStats` once commits move into highlights.** The card's counts must not drop. Covered in Task 3.
5. **A `workstreams.yml` with a merge conflict in it.** `ws` refuses rather than overwriting it, and a release fails loudly instead of silently losing its highlights. Covered in Tasks 1 and 3.

---

### Task 1: Workstreams in core

**Files:** create `packages/core/src/workstreams.ts`, and export it from `index.ts`. Add `yaml` to `packages/core/package.json`. Test: `packages/core/test/workstreams.test.ts`.

**Interfaces:**

- `const WORKSTREAMS_FILE = '.chamoji/workstreams.yml'`
- `type WorkstreamStatus = 'active' | 'shipped' | 'dropped'`
- `type Workstream = {slug: string; title: string; emoji?: string; description?: string; status: WorkstreamStatus; links?: string[]}`
- `class WorkstreamError extends Error`
- `slugify(title: string): string`, and `isSlug(value: string): boolean`
- `readWorkstreams(cwd): Promise<Workstream[]>` reads the working tree, `[]` when absent, and throws `WorkstreamError` when unparsable.
- `readWorkstreamsAt(cwd, ref): Promise<Workstream[]>` uses `git show`, `[]` when absent, and throws `WorkstreamError` when unparsable.
- `addWorkstream(cwd, input: {title; emoji?; description?}): Promise<Workstream>`, which throws if the slug exists.
- `setWorkstreamStatus(cwd, slug, status): Promise<Workstream>`
- `getActive(cwd): Promise<string | null>`: `null` unless the slug is `active` in the working-tree file.
- `setActive(cwd, slug: string | null): Promise<void>`
- `shouldStamp(input: {source?: string; rebasing: boolean}): boolean`
- `stampWorkstream(cwd, messageFile): Promise<string | null>` returns the slug it stamped.

The file:

```yaml
workstreams:
  auth-revamp:
    title: Auth revamp
    emoji: 🔐
    status: active
```

Entries with a bad slug, or no title, are skipped on read. Writes go through `parseDocument` and `setIn`, so comments survive. `addWorkstream` and `setWorkstreamStatus` finish with `git add`. Paths are relative to `rev-parse --show-toplevel`.

Stamping runs `git interpret-trailers --in-place --if-exists doNothing --trailer "Workstream: <slug>" <file>`. Verified: it goes above git's comment lines, it works on a subject-only message, and a second stamp changes nothing.

- [ ] **Failing tests:**
  - `slugify('Auth revamp!')` is `auth-revamp`, and `slugify('🔐')` throws `WorkstreamError`
  - add, then read back; a second add of the same slug throws
  - a hand-written comment in the file survives `setWorkstreamStatus`
  - a file with `<<<<<<<` conflict markers makes `addWorkstream` throw and leaves the file untouched
  - `readWorkstreamsAt` sees the status at that ref, not the working tree's
  - `getActive` is null for a slug that's shipped, dropped, missing or malformed (`"bad\nslug"`)
  - `shouldStamp` is true for `undefined`, `message` and `template`; false for `merge`, `squash`, `commit`, and when rebasing
  - `stampWorkstream` puts the trailer above comment lines, keeps an existing `Workstream:` trailer, and returns null with no active workstream
- [ ] **Run** `pnpm exec vitest run packages/core/test/workstreams.test.ts`. Expected: fails, module not found.
- [ ] **Implement,** then run it again. Expected: passes.
- [ ] **Commit** `✨ Add workstreams to core`

### Task 2: Read the trailer

**Files:** modify `packages/core/src/parse.ts` and `types.ts`. Test: `packages/core/test/parse.test.ts`.

**Interfaces:** `ParsedCommit` gains `workstream: string | null`.

- [ ] **Failing tests:**
  - `Workstream: auth-revamp` in `trailers` gives `auth-revamp`, and the key is case-insensitive
  - a body shaped like GitHub's squash message, whose last paragraph has no `Workstream:` line, still gives it
  - `Workstream: Not A Slug` gives null
  - a commit with neither gives null
- [ ] **Implement,** using `isSlug` from Task 1. Run `pnpm test`. Expected: passes.
- [ ] **Commit** `✨ Read the Workstream trailer`

### Task 3: Highlights in the changelog

**Files:** modify `packages/core/src/changelog.ts`, `types.ts` and `card.ts`. Create `packages/core/src/highlights.ts`. Test: `packages/core/test/highlights.test.ts`, `changelog.test.ts` and `card.test.ts`.

**Interfaces:**

- `type Highlight = Pick<Workstream, 'slug' | 'title' | 'emoji' | 'description' | 'links'> & {groups: Group[]}`
- `Release` gains `highlights?: Highlight[]`, present only when not empty.
- `splitHighlights(commits: ParsedCommit[], workstreams: Workstream[], config: GroupConfig): {highlights: Highlight[]; loose: ParsedCommit[]}`

`Pending` in `buildChangelog` gains the ref to read: `to` for the unreleased section, the tag otherwise. `bumpFor` still sees every commit. `groupCommits` gets `loose`. Highlights are ordered by each one's newest commit. `repoStats` adds highlight groups to its commit, misc and added/fixed/changed counts.

- [ ] **Failing tests:**
  - a shipped workstream's commits leave their sections and appear in its highlight; loose commits stay put
  - active, dropped and unknown slugs stay loose
  - a breaking commit stays under Breaking changes, and a hidden-group commit stays hidden
  - a workstream with only hidden commits gets no entry
  - a repo with no file has no `highlights` key at all (`'highlights' in release` is false)
  - a workstream shipped after `v1.0.0` leaves `v1.0.0` loose while the later release gets the entry
  - **exit criterion:** a 40-commit fixture across four shipped workstreams and six loose commits gives 4 highlights and 6 loose
  - an unparsable file at `to` throws, naming the file; one at an older tag is ignored
  - `next-version` is the same with and without highlights
  - `repoStats` totals are equal with and without highlights
- [ ] **Implement,** then run `pnpm test`. Expected: passes.
- [ ] **Commit** `✨ Fold shipped workstreams into Highlights`

### Task 4: Render Highlights

**Files:** modify `packages/core/src/render/markdown.ts` and `html.ts`. Test: `packages/core/test/render.test.ts`.

Highlights come first in a release. Markdown:

```markdown
### Highlights

- 🔐 **Auth revamp:** Sign in with passkeys.
  - ✨ Add login (abc1234)
  - 🐛 Fix logout (def5678)
```

HTML uses `<h3>Highlights</h3>`, then a `<details>` per workstream with the title in `<summary>`. JSON gets `highlights` from `renderJson` with no change. Dependency-collapse groups inside a highlight stay one summary line.

- [ ] **Failing tests:**
  - the Markdown above, exactly, from `renderCommit`'s existing output
  - with no description, the entry is `- 🔐 **Auth revamp**`; with no emoji, it has no leading space
  - `[x](https://evil)` and `<script>` in a title or description come out inert in both formats
  - `planRelease`'s notes and `insertSection` keep the Highlights section
- [ ] **Implement,** then run `pnpm test`. Expected: passes.
- [ ] **Commit** `✨ Render Highlights in Markdown and HTML`

### Task 5: `chamoji ws` and stamping

**Files:** create `packages/cli/src/ws.ts`. Modify `packages/cli/src/run.ts`. Test: `packages/cli/test/ws.test.ts` and `hook.test.ts`.

**Interfaces:** `runWorkstream(input: string[], flags: {json?: boolean; none?: boolean}, io: Io): Promise<number>`. Add a `none` boolean flag to meow, and the commands to `HELP`.

| Command                            | Behaviour                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `chamoji ws start <title> [emoji]` | Adds it, stages the file, makes it active.                                                              |
| `chamoji ws switch <slug>`         | Makes it active. Refuses a slug that isn't `active`, naming its status.                                 |
| `chamoji ws switch --none`         | Clears the active workstream.                                                                           |
| `chamoji ws list`, or bare `ws`    | Slug, status, title and unreleased commit count, with `*` on the active one. `--json` prints the array. |
| `chamoji ws ship [slug]`           | Defaults to the active one. Sets `shipped`, stages the file, clears active if it was this one.          |
| `chamoji ws drop [slug]`           | The same, with `dropped`. The entry stays in the file, and its commits stay loose.                      |

`start`, `ship` and `drop` print what they staged: `Shipped auth-revamp. Staged .chamoji/workstreams.yml; your next commit records it.`

In `runHook`, stamp on every path out of the `try`, including `shouldPrompt` saying no, after the composed message is written. The `rebasing` value gains `CHERRY_PICK_HEAD` and `REVERT_HEAD`, for stamping only: `shouldPrompt`'s input doesn't change. In `commit()`, call `stampWorkstream` on the temp file before `git commit -F`, so it works with no hook installed.

- [ ] **Failing tests** (fixture repos):
  - `ws start "Auth revamp" 🔐`, then `git commit -m` through the installed hook, gives a commit with `Workstream: auth-revamp`
  - `chamoji commit` with no hook installed stamps it too
  - `-m` with no active workstream leaves the message byte-identical
  - a merge commit and `--amend` aren't stamped, and an amend keeps the trailer it had
  - a message that already has `Workstream: other` keeps it
  - the composer path keeps git's comment lines below the trailer
  - `ship` with no slug and no active workstream exits 1 and says so
  - `switch` to a shipped workstream exits 1, naming the status
  - `ws list --json` counts a workstream's unreleased commits
  - a corrupt file makes `ws start` exit 1 with the file unchanged
- [ ] **Implement,** then run `pnpm test`. Expected: passes.
- [ ] **Commit** `✨ Add chamoji ws, and stamp the active workstream`

### Task 6: Prove it, and document it

**Files:** modify `scripts/hook-e2e.py`, `readme.md` and `docs/ROADMAP.md`.

- [ ] **Add a check to `hook-e2e.py`:** after the existing three, run `chamoji ws start`, commit with `-m`, and assert the trailer. It then runs in every shell, and through husky and lefthook, in the Hook workflow.
- [ ] **Run** `python3 scripts/hook-e2e.py --shell bash`. Expected: four `ok` lines.
- [ ] **Readme:** a "Workstreams" section with the flow, what's committed and what's local, the Highlights rule, and the squash limits below.
- [ ] **Exit criterion, on real GitHub:** in a throwaway repo, open a PR with two stamped commits and squash-merge it, then run `chamoji changelog` on the result. Record the outcome for both of GitHub's default squash-message settings ("default message" and "PR title and description"). **Creating the repo is outward-facing, so ask first.** The second setting is expected to lose the trailer; if it does, the readme must say so and name the fix, adding the line to the PR description.
- [ ] **Roadmap:** the milestone's status, plan link and exit-criteria results.
- [ ] **Run** `pnpm test && pnpm check`. Expected: passes.
- [ ] **Commit** `📝 Document workstreams and record the exit criteria`
- [ ] **Dogfood:** per the roadmap's rule, a milestone isn't done until we've used it for a sprint. Run milestone 7 as a workstream in this repo before calling this one finished.

### Later (not in this plan)

- **`git notes` for old commits** and AI-suggested grouping: milestone 9.
- **AI summaries** on each highlight: needs the prose LLM from milestone 5's later list.
- **Choosing a workstream in the composer:** a step for it, once people are using `ws` enough to want it.
