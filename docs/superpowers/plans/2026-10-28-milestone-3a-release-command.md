# Milestone 3a: `chamoji release` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `chamoji release` cuts a release in one command: preflight, version, CHANGELOG.md, manifest bumps, release commit and annotated tag, plus push and GitHub release on request.

**Architecture:**

- **Engine:** `packages/core/src/release.ts` holds all the logic, in three steps.
  - `planRelease` reads only and decides everything.
  - `applyRelease` writes, commits and tags, and rolls back on failure.
  - `pushRelease` pushes the commit and tag.
  - Small pure helpers do the text work, so most behaviour is unit-testable.
- **CLI:** `packages/cli/src/run.ts` adds the `release` command. It turns preflight errors into exit codes, prints a short report or `--json`, and runs `gh release create` after `--push` when `gh` is installed.
- **Port, not a design:** this ports `skills/chamoji-release/scripts/release.mjs`, which was tested on three fixture repos during the skill work. That script stays as the skill's fallback until 0.5.0 is on npm.

**Tech stack:** as milestone 1 (TypeScript, `semver`, meow, vitest, git without a shell).

**Spec:** `docs/ROADMAP.md`, milestone 3 ("GitHub Action"). This plan is the command its Action wraps. The behaviour comes from `skills/chamoji-release/scripts/release.mjs`.

## Global constraints

- **The version is a positional argument:** `chamoji release [version]`. `--version` already prints chamoji's own version.
- **Exit codes:** 0 released (or dry run), 3 nothing to release (`NO_RELEASE_NEEDED`), 2 a preflight check failed, 1 anything else.
- **git runs through `runGit` (no shell) only.** `gh` runs through `execFile`, also without a shell.
- **Nothing reaches a remote without `--push`.** `--push` pushes `HEAD` and the one tag by name, never `--tags`.
- **Existing CHANGELOG.md entries are never rewritten.** The new section goes above the first release heading, below the title and any `Unreleased` section. A missing file is created from the full history.
- **The new section is chamoji's own Markdown,** exactly as `changelog --from <last> --release <tag>` renders it, without the `# Changelog` heading.
- **The tag prefix follows the newest semver tag:** `v` when it has one, none when it doesn't, and `v` when there are no tags.
- **Release subjects are ones chamoji hides from changelogs:**
  - `🔖 Release <tag>` for gitmoji repos
  - `chore(release): 🔖 <tag>` for Conventional Commits repos
  - `Release <tag>` for plain repos
- **Commits** in this repo use gitmoji messages and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A failure halfway through**, such as a pre-commit hook rejecting the commit. The repo must be back at the starting commit with no tag. Covered in Task 3.
2. **A push that fails after the tag exists.** Keep the local release and say so; never roll back after the tag. Covered in Tasks 3 and 4.
3. **A lockfile or monorepo where a dependency has the same version string as the package.** Only the package's own `version` field, and the root entry in `package-lock.json`, may change. Covered in Task 1.
4. **A hand-written changelog with an `## [Unreleased]` section.** The release goes below it, and both are kept. Covered in Task 1.
5. **A shallow clone (CI, cloud sandboxes).** Unshallow before reading tags, or stop with exit 2. Covered in Task 2.

---

### Task 1: Pure release helpers

**Files:**

- Create: `packages/core/src/release.ts` (helpers section)
- Test: `packages/core/test/release.test.ts`

**Interfaces (produces):**

- `insertSection(changelog: string, section: string): string`
- `bumpManifest(file: string, text: string, from: string | null, to: string): string | null`: the new text, or `null` when the file doesn't carry `from` (or, for a first release, already says `to`)
- `releaseSubject(recentSubjects: string[], tag: string): string`
- `tagPrefix(tags: string[]): 'v' | ''`

- [ ] **Step 1: Write the failing tests**

  - `insertSection`:
    - puts the section above `## [v1.2.0]` and keeps everything below it byte for byte
    - keeps `## [Unreleased]` and its body above the new section
    - with no release heading, appends after the title
  - `bumpManifest`:
    - `package.json` from `1.2.0` to `1.3.0` changes only the top-level `"version"` and keeps tabs and the trailing newline
    - a `package-lock.json` whose dependency `"left-pad": {"version": "1.2.0"}` matches the old version changes only the root `version` and `packages[""].version`
    - `pyproject.toml` and `Cargo.toml` change `version = "…"`
    - returns `null` when the file's version differs from `from`
  - `releaseSubject`:
    - 30 gitmoji subjects → `🔖 Release v1.3.0`
    - mostly `fix:`/`feat:` subjects → `chore(release): 🔖 2.0.2`
    - plain subjects → `Release v1.0.0`
  - `tagPrefix`: `['v1.2.0']` → `'v'`, `['2.0.1']` → `''`, `[]` → `'v'`

- [ ] **Step 2: Run them and see them fail:** `pnpm vitest run packages/core/test/release.test.ts`
- [ ] **Step 3: Implement the four helpers**, porting `insertSection`, `bumpManifests` and `releaseSubject` from `skills/chamoji-release/scripts/release.mjs`. `bumpManifest` works on text with regexes, so formatting survives; `package-lock.json` gets the extra `packages[""]` replacement.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `✨ Add release text helpers to core`

### Task 2: `planRelease`

**Files:**

- Modify: `packages/core/src/release.ts`, `packages/core/src/index.ts` (export the public API)
- Test: `packages/core/test/release.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers, `buildChangelog`, `renderMarkdown`, `listReleaseTags`, `runGit`, `loadConfig`
- Produces:

```ts
export class ReleaseError extends Error {
	code:
		| 'dirty'
		| 'branch'
		| 'shallow'
		| 'first-release'
		| 'not-newer'
		| 'tag-exists'
		| 'invalid-version';
}
export type ReleaseOptions = {
	cwd: string;
	config: ChamojiConfig;
	version?: string; // explicit version, with or without "v"
	anyBranch?: boolean;
	fetch?: boolean; // fetch tags from origin first; default true
	today?: string;
	classify?: CommitClassifier;
	allowDirty?: boolean; // dry runs only
};
export type ReleasePlan =
	| {status: 'nothing'; lastTag: string; unreleased: string[]}
	| {
			status: 'ready';
			version: string;
			tag: string;
			lastTag: string | null;
			bump: SemverBump | 'prerelease' | 'first';
			notes: string; // the new section, no "# Changelog" heading
			changes: Array<{file: string; text: string; how: string}>; // CHANGELOG.md first
			subject: string;
			start: string; // HEAD hash
			warnings: string[];
	  };
export function planRelease(options: ReleaseOptions): Promise<ReleasePlan>;
```

- [ ] **Step 1: Write the failing tests** (fixture repos via `createRepo`, `fetch: false`, `today: '2026-10-28'`):
  - gitmoji history `v1.2.0` → ✨ + 🐛 + 3 ⬆️: `ready`, `version: '1.3.0'`, `tag: 'v1.3.0'`, `bump: 'minor'`. The notes start with `## [v1.3.0]` and have one `⬆️ 3 dependency updates` line.
  - Conventional history tagged `2.0.1` (no v): `tag: '2.0.2'`, subject `chore(release): 🔖 2.0.2`
  - only 📝 ✅ ♻️ since `v0.3.0`: `status: 'nothing'`, with those three subjects in `unreleased`
  - no tags and no `version`: throws `ReleaseError` with code `first-release`. With `version: '0.1.0'`: `bump: 'first'`, and the `CHANGELOG.md` change `how` says it was created from the full history.
  - `version: '1.0.0'` when `v1.2.0` exists → `not-newer`. `version: 'banana'` → `invalid-version`.
  - an uncommitted file → `dirty`, and `allowDirty: true` plans anyway
  - an existing tag `v1.3.0` with `version: '1.3.0'` → `tag-exists`
  - `refs/remotes/origin/HEAD` pointing at `origin/trunk` while on `main` → `branch`, and `anyBranch: true` passes
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `planRelease`**:
  1. assert it's a repo
  2. check the dirty tree and the branch
  3. if shallow, `fetch --unshallow --tags`, else `fetch --tags` when `fetch` is set, adding a warning on failure
  4. read semver tags with `listReleaseTags`
  5. take the version from `options.version` or from the unreleased release's `nextVersion` (as `next-version` does)
  6. build the notes with `buildChangelog({from: lastTag, release: tag})` and `renderMarkdown`, stripping the heading
  7. build the CHANGELOG.md change (`insertSection`, or the full render when the file is missing) and the manifest changes (`git ls-files` for `package.json`, `package-lock.json`, `pyproject.toml`, `Cargo.toml`, skipping `node_modules`)
  8. pick the subject from the last 30 non-merge subjects
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `✨ Plan releases in core`

### Task 3: `applyRelease` and `pushRelease`

**Files:**

- Modify: `packages/core/src/release.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/release.test.ts`

**Interfaces:**

- `applyRelease(plan: ReadyPlan, cwd: string, options?: {trailers?: string[]}): Promise<{commit: string}>`: writes `changes`, runs `git add`, commits `subject` with each trailer as `--trailer`, and tags `-a tag -m tag`. On any failure before the tag exists, it deletes the tag, runs `git reset --hard start`, and rethrows with "rolled back" in the message.
- `pushRelease(plan: ReadyPlan, cwd: string): Promise<void>`: runs `git push origin HEAD <tag>`. It throws on failure, and the caller keeps the release.

- [ ] **Step 1: Write the failing tests:**
  - **applied plan:** HEAD's subject is `🔖 Release v1.3.0`, `git cat-file -t v1.3.0` is `tag`, the tag points at HEAD, the tree is clean, and `package.json` says `1.3.0`
  - **trailers:** `trailers: ['Co-Authored-By: A <a@b.c>']` puts that trailer in the commit body
  - **rejecting pre-commit hook:** it throws, HEAD equals `plan.start`, no `v1.3.0` tag exists, and the tree is clean
  - **push to a local bare remote:** the remote has `refs/tags/v1.3.0` and `main`
  - **push to a missing remote:** it throws, and the local tag still exists
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement both functions with `runGit`.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `✨ Apply and push releases in core`

### Task 4: The `release` command

**Files:**

- Modify: `packages/cli/src/run.ts` (HELP, flags, `case 'release'`)
- Test: `packages/cli/test/run.test.ts`

**Interfaces:**

- **Consumes:** Task 2 and 3 functions.
- **Flags:** `--dry-run`, `--push`, `--any-branch`, `--json`, `--trailer` (string, multiple), plus the existing `--ai` and `--config`. The version is `cli.input[1]`.
- **`Io` gains an optional `gh` runner:** `gh?: (args: string[]) => Promise<{ok: boolean; message: string}>`. The default calls `execFile('gh', args)` and reports "not installed" when it hits ENOENT. Tests pass a fake.
- **Report** (stdout, one fact per line):

  ```
  Released v1.3.0 (minor, from v1.2.0).
  changelog: CHANGELOG.md, <how>
  bumped: package.json
  commit: <short> 🔖 Release v1.3.0
  tag: v1.3.0 (annotated)
  pushed: no; to ship: git push origin HEAD v1.3.0
  warning: …
  undo before pushing: git tag -d v1.3.0 && git reset --hard <start7>
  (blank line)
  <notes>
  ```

  `--json` prints the same facts as one object: `status`, `version`, `tag`, `bump`, `files`, `commit`, `pushed`, `githubRelease`, `warnings` and `notes`.

- **Exit codes:** `ReleaseError` → 2, nothing to release → 3 (with "Nothing to release" and the unreleased subjects), success and dry run → 0, anything else → 1. A push failure prints that the local release was kept, and exits 1.

- [ ] **Step 1: Write the failing tests** (fixture repos, so `run()` needs `fetch: false`, via `Io.fetchTags?: boolean`, default true):
  - `release` on a feature history: exits 0, stdout starts with `Released v1.1.0 (minor, from v1.0.0).`, and the tag exists
  - `release --dry-run`: exits 0, stdout starts `Would release v1.1.0`, and no tag or commit is made
  - `release` with nothing to release: exits 3, and stdout has `Nothing to release`
  - `release` on a dirty tree: exits 2, and stderr mentions uncommitted changes
  - `release 1.0.0` when `v1.0.0` exists: exits 2
  - `release --json`: `JSON.parse(stdout).tag === 'v1.1.0'`
  - `release --push` to a bare remote with a fake `gh` that succeeds: `pushed` and `githubRelease` are both true, and the fake got `['release', 'create', 'v1.1.0', '--title', 'v1.1.0', '--notes-file', <path>]`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the command.** Write the notes to `.git/chamoji-release-notes.md` for `gh`. Add `--prerelease` when the version has a `-`. Update HELP with the command, its flags and an example.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `✨ Add chamoji release`

### Task 5: Docs and dogfooding

**Files:**

- Modify:
  - `readme.md`: the Usage block, a "Cutting a release" section that replaces the typical-flow shell snippet, and the coding-agent section
  - `docs/ROADMAP.md`: milestone 3 progress, with the status row set to 🚧
  - `package.json`: `release` becomes `pnpm build && node packages/cli/dist/cli.js release --trailer …`
  - delete `scripts/release.mjs`

- [ ] **Step 1: Check the dogfood flow:**
  - Run `pnpm release --dry-run` on main. It exits 0, or 3 if nothing is unreleased.
  - The plan lists `packages/core/package.json` and `packages/cli/package.json` as bumps, and leaves the root `package.json` alone, since it has no version.
  - Its CHANGELOG.md output stays Prettier-clean (`prettier --check` on a scratch copy).
- [ ] **Step 2: Update the readme and roadmap.**
- [ ] **Step 3: `pnpm check && pnpm test`.**
- [ ] **Step 4: Commit** `📝 Document chamoji release and cut our releases with it`

### After 0.5.0 is on npm (the owner publishes)

- **The skill:** switch `skills/chamoji-release/SKILL.md` to `npx --yes @chamoji/cli@latest release`, and delete `skills/chamoji-release/scripts/release.mjs`. Also point `references/ci.md` at the command instead of a copied script.
- **Milestone 3, second half:** the GitHub Action, as a thin wrapper around `chamoji release` and `changelog`.
