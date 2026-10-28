# Milestone 2: Public Launch Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** people can find chamoji, trust it, contribute to it and hear about new versions. The milestone ends with v0.4.0 published by CI from a public GitHub repo.

**Architecture:**

- **Update notice:** a small module of our own, with no new runtime dependency beyond `semver`.
  - Each run reads a cached result synchronously and prints the notice to stderr after the command.
  - When the cache is older than 24 hours, a detached worker process refreshes it, so the command never waits on the network.
- **Repo and CI:** GitHub Actions for CI and for tag-triggered publishing with npm provenance.

**Spec:** `docs/ROADMAP.md`, milestone 2.

## Global constraints

- **The update check is the only network call that's on by default** (principle 4's exception).
  - It's a single GET to `https://registry.npmjs.org/@chamoji%2fcli/latest`.
  - It sends nothing about the user or their repo.
  - It runs at most once every 24 hours.
- **The notice goes to stderr only.** It never appears in CI (`CI` set), when stderr isn't a terminal, with `NO_UPDATE_NOTIFIER`, with `CHAMOJI_NO_UPDATE_CHECK=1` or with `--no-update-check`.
- **Prereleases on npm never trigger a notice.**
- **Outward-facing steps are done by the maintainer or with their explicit go-ahead:** creating the public repo, `npm deprecate`, npm trusted-publisher setup and publishing the waitlist page.
- Commits use gitmoji messages and end with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## Review focus

1. **`chamoji next-version` inside `$(…)`.** Stderr is a terminal there but stdout isn't, so stdout must stay exactly the version and nothing else.
2. **An unwritable config directory, or a corrupt cache file.** The command must still run normally, with no notice.
3. **A slow or offline network.** No extra latency: the refresh is detached, and the worker exits after its timeout.

## Decisions taken here

- **Our own module, not `update-notifier`.** `update-notifier` adds about 30 transitive packages (configstore, boxen, chalk and others) for a feature that takes about 100 lines. gitmoji-cli uses it; we don't need its box drawing or config store.
- **Release target:** v0.4.0. The roadmap's earlier "0.2.1" predates 0.3.0.
- **Already done in milestone 1.6:** `.env` support and `CONTRIBUTING.md`.

---

### Task 1: Update notice

**Files:**

- Create: `packages/cli/src/update-check.ts`, `packages/cli/src/update-worker.ts`
- Modify: `packages/cli/src/run.ts`, `packages/cli/src/cli.ts`, `packages/cli/package.json` (add `semver`)
- Test: `packages/cli/test/update-check.test.ts`

**Interfaces:**

- `updateCheckEnabled(env: NodeJS.ProcessEnv, stderrIsTTY: boolean, flag: boolean): boolean`
- `cacheFile(env: NodeJS.ProcessEnv, platform = process.platform, home = os.homedir()): string`. Resolution order:
  1. `$XDG_CONFIG_HOME/chamoji/update-check.json`
  2. on Windows, `%APPDATA%\chamoji\update-check.json`
  3. otherwise `~/.config/chamoji/update-check.json`
- `readCache(file): {checkedAt: number; latest: string} | undefined`. Corrupt or missing files give undefined.
- `isStale(cache, now): boolean`, true after 24 hours.
- `installKind(scriptPath: string, cwd: string): 'npx' | 'project' | 'global'`
  - a path containing `/_npx/` is `npx`
  - a path inside `<cwd or an ancestor>/node_modules/` is `project`
  - anything else is `global`
- `updateNotice(current: string, latest: string, kind): string | undefined`. It gives undefined unless `latest` is a stable version greater than `current`. Messages:
  - global: `chamoji <latest> is available (you have <current>): npm i -g @chamoji/cli@latest`
  - npx: `… run npx @chamoji/cli@latest`
  - project: `… update @chamoji/cli in package.json`
- `UpdateCheck = {notice(): string | undefined; refreshIfStale(): void}`
- `createUpdateCheck(options): UpdateCheck` is the real implementation. `Io` gains an optional `updateCheck?: UpdateCheck`; when omitted, `run()` builds the real one.
- The worker, `update-worker.js <cacheFile>`, fetches with a 5 second timeout and writes `{checkedAt, latest}` atomically: write a temp file, then rename. Any failure exits silently.

**Steps:**

- [ ] Write tests for:
  - each off switch
  - `cacheFile` on each platform
  - a corrupt cache
  - staleness
  - each `installKind`
  - notices for newer, equal, older and prerelease versions
  - `run` printing the notice to stderr only, with stdout byte-for-byte unchanged
  - `run` with `--no-update-check`
- [ ] Run them and confirm they fail.
- [ ] Implement.
- [ ] Run them and confirm they pass.
- [ ] Try it by hand with a fake cache that says `9.9.9`.
- [ ] Commit `✨ Tell users when a newer chamoji is available`.

### Task 2: Reach users of old versions (maintainer)

- [ ] After 0.4.0 is published, run:

  ```bash
  npm deprecate @chamoji/cli@"<0.3.0" "Please update: npm i -g @chamoji/cli@latest"
  npm deprecate @chamoji/core@"<0.3.0" "Please update to the latest @chamoji/core"
  ```

- [ ] Check that `npm install @chamoji/cli@0.1.0` prints the message.

### Task 3: Repo files

**Files:**

- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)
- `SECURITY.md`, with a private reporting route
- `.github/ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,config.yml}`
- `.github/pull_request_template.md`

**Steps:**

- [ ] Write the files.
- [ ] Commit `📝 Add community files`.

### Task 4: CI

**Files:** `.github/workflows/ci.yml`

**What it runs:**

- **Triggers:** pushes to `main` and pull requests.
- **Matrix:** `ubuntu-latest`, `macos-latest` and `windows-latest`, each on Node 22 and 24.
- **Steps:** `pnpm install --frozen-lockfile`, then `pnpm check`, then `pnpm test`.

**Steps:**

- [ ] Write the workflow.
- [ ] Commit `👷 Add CI`.
- [ ] It runs once the repo is on GitHub (Task 6). Fix anything that fails on Windows there.

### Task 5: Release workflow with provenance

**Files:** `.github/workflows/release.yml`

**What it does:**

- **Trigger:** pushing a `v*` tag.
- **Steps:**
  1. Install, check and test.
  2. Check that the tag matches both package versions.
  3. Run `pnpm publish -r --provenance --access public --no-git-checks`.
- **Auth:** npm trusted publishing (OIDC). The job has `id-token: write` and no npm token.

**Steps:**

- [ ] Write the workflow.
- [ ] Commit `👷 Publish releases from CI with provenance`.
- [ ] **Maintainer:** on npmjs.com, add the GitHub repo and `release.yml` as the trusted publisher for both packages.

### Task 6: Public GitHub repo (needs the owner decision)

- [ ] **Maintainer:** create the repo under the chosen owner. Then push `main` and the tags.
- [ ] Add `repository`, `homepage` and `bugs` to both packages and to `CONTRIBUTING.md`.
- [ ] Commit `📝 Link packages to the GitHub repo`.

### Task 7: Readme demo

- [ ] Record a plain-message repo before and after. Use `vhs` (charmbracelet) or asciinema, and save the result as `docs/demo.gif`.
- [ ] Add it to the readme.

### Task 8: Telemetry decision (needs a decision)

- [ ] **If telemetry is built:** write `docs/telemetry.md` describing it before any code. It is off by default and collects the command, counts and timings, never commit text.
- [ ] **If not:** we rely on npm downloads and GitHub stats, and record that in the roadmap.

### Task 9: Cloud waitlist page (needs the host decision)

- [ ] **Build:** a single page that uses the brand (foil plate, Marow Block, Tansa) and collects emails. Hosting and email capture depend on the decision.

### Task 10: Benchmarks and release

- [ ] **Benchmarks:** add two messy real-world repos to the benchmark list, then record before and after numbers in the roadmap.
- [ ] **Release:** cut v0.4.0 with `pnpm release`, then push the tag so `release.yml` publishes it.
- [ ] **Roadmap:** update the milestone 2 status and its results.
