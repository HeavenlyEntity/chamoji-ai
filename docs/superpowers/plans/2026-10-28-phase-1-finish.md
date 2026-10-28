# Finish Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close Phase 1: milestone 2's last two items (benchmarks and the readme demo GIF), and milestone 3's GitHub Action, built on `chamoji release` from milestone 3a.

**Architecture:**

- **Benchmarks:** `scripts/benchmark.mjs` clones each benchmark repo without file contents (`--filter=blob:none`) into a cache folder. It runs the built CLI's `changelog --format json` and prints each repo's Miscellaneous share as a Markdown table.
- **`changelog --since <ref>`:** a new core and CLI option that renders only the commits after any ref, as one Unreleased section. The Action uses it to show what a PR adds.
- **The Action:** a composite `action.yml` at the repo root, run with bash and the preinstalled `gh`. It calls the CLI through `npx`, or through a command given in the `cli` input. It has three modes:
  - `notes` on tag push
  - `comment` on pull requests
  - `release` on request, which runs `chamoji release --push`
- **Chamoji uses it on itself:** `.github/workflows/chamoji.yml` runs `uses: ./` on chamoji's own PRs and tags, with `cli` pointed at the local build.
- **Demo:** `docs/demo/setup.sh` builds a throwaway plain-message repo, and `docs/demo/demo.tape` records the CLI on it with vhs into `docs/demo.gif`.

**Tech stack:** as milestone 3a, plus GitHub composite actions, `gh` and [vhs](https://github.com/charmbracelet/vhs).

**Spec:** `docs/ROADMAP.md`, milestones 2 (demo and benchmark items) and 3. Earlier plans: `2026-10-28-milestone-2-public-launch-kit.md` tasks 7 and 10, and `2026-10-28-milestone-3a-release-command.md`.

## Global constraints

- **The Action never pushes or comments with more than the token it's given.**
  - `comment` mode needs `pull-requests: write`.
  - `notes` and `release` need `contents: write`.
  - On fork PRs, where the token can't comment, the preview goes to the job summary instead, and the step still passes.
- **One PR comment, updated in place.** It's found by the hidden marker `<!-- chamoji-changelog -->`, never by its wording.
- **No `${{ … }}` expressions in `run:` scripts.** Inputs and event data reach bash only through `env:`.
- **Checkouts need full history.** The Action fails with a clear message when the clone is shallow and `fetch-depth: 0` is missing.
- **Benchmarks report the Miscellaneous share without `--ai`,** as the roadmap's metric does.
- **Owner-only steps,** marked "Owner" below:
  - publishing to npm
  - listing on the Marketplace
  - opening PRs or pushing tags on the public repo
- **Commits** use gitmoji and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A PR from a fork.** Commenting must fail softly to the job summary, never fail the check. Covered in Task 3.
2. **A tag that isn't the newest.** The notes must cover only that tag's commits. Covered in Task 3, where `previous` comes from the tag's own ancestry.
3. **`--since` with a ref that isn't an ancestor of `--to`,** such as a base branch that moved on. It should mean `git log since..to`, the commits on `to` that `since` lacks, which is right for PRs. Covered in Task 2.
4. **A repo with no semver tags yet** in `comment` mode. Show the lines and say "first release", not an error. Covered in Task 3.
5. **Running the benchmark offline, or on a repo that has been renamed.** Report that repo as failed and keep going. Covered in Task 1.

---

### Task 1: Benchmark script and two messy repos

**Files:** create `scripts/benchmark.mjs`. Modify `docs/ROADMAP.md` (benchmark list and results table), `.gitignore` (`.benchmarks/`) and `package.json` (`"benchmark": "pnpm build && node scripts/benchmark.mjs"`).

- [ ] **Repos:**
  - the existing four: `carloscuesta/gitmoji`, `carloscuesta/gitmoji-cli`, `sindresorhus/meow`, `vitejs/vite`
  - two messy ones: `jquery/jquery` ("Component: description" subjects) and `moment/moment` (`[bugfix]`-style tags and plain messages)
- [ ] **Per repo:** clone or fetch it into `.benchmarks/<name>` with `--filter=blob:none`. Run `node packages/cli/dist/cli.js changelog --format json --no-update-check`, and count the commits in the `misc` group out of all commits. Print `| repo | commits | Miscellaneous |`. A failed clone prints `failed` and carries on.
- [ ] **Run it** and record the table in the roadmap, under milestone 2's benchmark item.
- [ ] **Commit** `📈 Add the benchmark script and two messy repos`.

### Task 2: `changelog --since <ref>`

**Files:** modify `packages/core/src/changelog.ts` (a `since` option) and `packages/cli/src/run.ts` (the flag and HELP). Test: `packages/core/test/changelog.test.ts` and `packages/cli/test/run.test.ts`.

**Interfaces:** `BuildChangelogOptions.since?: string`. When it's set, the changelog has one release, made of the commits in `since..to` (`version: 'Unreleased'`, `tag: null`), and tags are ignored for grouping. It can't be combined with `from` or `release` (the error says so). `nextVersion` is still worked out from the last tag, so callers can show the bump the PR implies.

- [ ] **Tests:**
  - the history `🎉 Init`, `v1.0.0`, `✨ A`, then the base, `🐛 B`, `✨ C`: `--since <base>` lists only B and C
  - an unknown ref → `Unknown revision: nope`
  - `--since` with `--from` → an error naming both flags
  - CLI: `changelog --since HEAD~1 --format json` has one release
- [ ] **Implement** `since` with `assertRevision` and `readCommits(cwd, `${since}..${to}`)`.
- [ ] **Commit** `✨ Add changelog --since for branch previews`.

### Task 3: The GitHub Action

**Files:**

- Create:
  - `action.yml`
  - `action/run.sh` (all the logic, so `action.yml` stays declarative)
  - `.github/workflows/chamoji.yml` (chamoji running the Action on itself)
  - `packages/cli/test/action.test.ts`, which runs `action/run.sh` against fixture repos with a fake `gh` on `PATH`, skipped on Windows
- Modify: `readme.md`, with a "GitHub Action" section

**Interfaces:**

- **Inputs:**
  - `mode`: `auto`, `notes`, `comment` or `release`
  - `chamoji-version`, default `latest`
  - `cli`, which overrides the command; chamoji's own workflow uses it
  - `ai`, default `false`
  - `typesafe-api-key`
  - `github-token`, default `${{ github.token }}`
- **Outputs:** `version` and `notes-file`.
- **`auto` mode:** a `push` of a `refs/tags/*` ref → `notes`, `pull_request` or `pull_request_target` → `comment`, anything else → an error asking for `mode`.

**`action/run.sh`** (bash, `set -euo pipefail`, inputs from env):

- **`notes`:** `previous` is the newest semver tag merged into `$TAG^`. Notes come from `changelog --to "$TAG" --from "$previous"` without the `# Changelog` line. Then `gh release edit "$TAG" --notes-file` when the release exists, else `gh release create "$TAG" --title "$TAG" --notes-file …` (with `--prerelease` for a `-` version).
- **`comment`:**
  1. The lines come from `changelog --since "$BASE_SHA" --to "$HEAD_SHA"`, without the first two headings.
  2. The bump comes from `next-version --to "$HEAD_SHA"`. Exit 3 means "no release-worthy changes".
  3. The body has the marker, a one-line summary ("Merging this makes the next release **v1.4.0** (minor)."), and the lines.
  4. The script looks for an existing marker comment through `gh api repos/$REPO/issues/$PR/comments --paginate`, then PATCHes it or POSTs a new one.
  5. If the API refuses, the body goes to `$GITHUB_STEP_SUMMARY` and the script exits 0.
- **`release`:** configure the `github-actions[bot]` identity, then run `release --push --json`. Set the `version` output from the JSON.
- **Every mode:** append the notes or preview to `$GITHUB_STEP_SUMMARY`.

- [ ] **Step 1: Failing tests** (fake `gh` records its arguments and returns canned JSON):
  - `notes` on a tag `v1.1.0` after `v1.0.0` → `gh release create v1.1.0 …`, with a notes file containing `Add search` and no `# Changelog`
  - `notes` when the release exists → `gh release edit`
  - `comment` with no marker comment → a POST whose body contains the marker and `**v1.1.0** (minor)`
  - `comment` with a marker comment → a PATCH to that comment's id, and no POST
  - `comment` when the fake `gh api` fails → exit 0, with the preview in the summary file
  - `comment` on a repo with no tags → the body says "first release"
- [ ] **Step 2: Write `action/run.sh` and `action.yml`.** The composite runs `actions/setup-node@v4` with Node 22, then `bash "$GITHUB_ACTION_PATH/action/run.sh"`, and passes everything through `env:`.
- [ ] **Step 3: Chamoji's own workflow.** `.github/workflows/chamoji.yml` runs on `pull_request` and on `push` of `v*` tags. It checks out with `fetch-depth: 0`, runs `pnpm install` and `pnpm build`, then `uses: ./` with `cli: node packages/cli/dist/cli.js`.
- [ ] **Step 4: Readme section** with copy-paste workflows for PR comments plus tag notes, and for button-press releases.
- [ ] **Step 5: Commit** `✨ Add the chamoji GitHub Action`.
- [ ] **Step 6 (Owner): open a PR.** That checks the comment appears and updates in place. Merge it, then push a tag to check the release notes.

### Task 4: Readme demo GIF

**Files:** create `docs/demo/setup.sh`, `docs/demo/demo.tape` and `docs/demo.gif`. Modify `readme.md` (the GIF under the tagline).

- [ ] **`setup.sh`** builds `/tmp/chamoji-demo`, a repo with plain, messy subjects ("Add login", "fix typo", "Bump vite…" ×3, "Fix crash when list is empty", "update deps") and a `v1.2.0` tag, using fixed dates.
- [ ] **`demo.tape`**, under 20 seconds at 1200×700, dark theme:
  1. `git log --oneline` (the mess)
  2. `chamoji changelog --from v1.2.0` (sorted)
  3. `chamoji release --dry-run`
- [ ] **Render** with `vhs docs/demo/demo.tape`, installing it with `brew install vhs` if it's missing. Check the GIF is under 2 MB.
- [ ] **Commit** `📝 Add the readme demo`.

### Task 5 (Owner): Publish 0.5.0

- [ ] `pnpm release --push`. The `v0.5.0` tag runs `release.yml`, which publishes to npm. Then `chamoji.yml` writes the GitHub release notes.

### Task 6: After 0.5.0 is on npm

- [ ] **The skill:** `skills/chamoji-release/SKILL.md` runs `npx --yes @chamoji/cli@latest release`. Delete `scripts/release.mjs`. `references/ci.md` points at the Action.
- [ ] **The roadmap:** milestone 2 and the first half of milestone 3 are ✅. The Action is ✅ once a real PR comment and tag notes have been seen.
- [ ] **(Owner) Marketplace listing.** If the Marketplace won't list an action from a repo that also holds other workflows and packages, publish it from a small `HeavenlyEntity/chamoji-action` repo whose `action.yml` delegates to this one.
