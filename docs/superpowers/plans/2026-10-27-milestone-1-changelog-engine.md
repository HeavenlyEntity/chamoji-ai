# Milestone 1: Changelog Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Ink prototype with a tested, AI-free engine. After this milestone, `chamoji changelog` writes a correct changelog (Markdown, JSON or HTML) from gitmoji and Conventional Commits history.

**Architecture:**

- The repo becomes a pnpm workspace with two packages: `packages/core`, a pure TypeScript library (git reading, parsing, grouping, versioning, rendering), and `packages/cli`, a meow command that calls core.
- Core reads git through `execFile`, so no shell is involved.
- The emoji list comes from the official `gitmojis` package.
- Tests build real throwaway git repos.

**Tech Stack:** Node ≥ 22, pnpm 10 workspaces, TypeScript 6.0 (`tsc` build, NodeNext ESM), Vitest 5, meow 14, semver 7, gitmojis 3.15.

**Spec:** `docs/research/2026-10-27-chamoji-direction.md` (sections 1, 3, 8.1)

## Global Constraints

- `engines.node`: `>=22`. All packages are ESM (`"type": "module"`), and relative imports use `.js` extensions.
- Core makes no network calls and has no UI dependencies. Git is always run with `execFile('git', args)`, never with a shell string.
- The emoji list comes only from the `gitmojis` package. Codes are the `code` field with the colons removed, such as `white_check_mark`.
- Before comparing, emoji are normalized by deleting U+FE0F (the variation selector).
- Merge commits are excluded (`--no-merges`).
- The group config must keep accepting the existing array format (`[{group, label, emojis}]`).
- Commits use gitmoji messages and end with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- Out of scope: Ink, AI, workstreams, hooks and iii.

## Review Focus

1. **Emoji with and without U+FE0F**, for example `⚡ fix` vs `⚡️ fix`. Both must map to `zap`. Covered in Task 2 (`parse.test.ts`).
2. **Repo with no tags.** It should give one "Unreleased" release rather than an error. Covered in Task 4 (`changelog.test.ts`).
3. **Prerelease tags** (`v1.0.0-rc.1`, `v1.0.0`). Order them by semver, not by string. Covered in Task 4.
4. **Commit text containing `<script>` or Markdown/HTML characters.** It must be escaped in HTML output and must not inject HTML into Markdown. Covered in Task 5.
5. **A breaking change without 💥**, such as `feat!: ✨ new API` or a `BREAKING CHANGE:` footer. It should land in "Breaking changes" and give a major bump. Covered in Tasks 2, 3 and 4.

---

## File structure

```
package.json                 private workspace root: scripts build/test/check
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts             aliases @chamoji/core → packages/core/src/index.ts
packages/core/
  package.json  tsconfig.json
  src/index.ts               public exports
  src/types.ts               RawCommit, ParsedCommit, Trailer, Group, Release, Changelog, ChamojiConfig
  src/git.ts                 runGit, readCommits, listReleaseTags, getRemoteWebUrl, toWebUrl
  src/gitmojis.ts            GITMOJIS, getGitmoji, findGitmoji, normalizeEmoji
  src/parse.ts               parseCommit
  src/config.ts              DEFAULT_GROUP_CONFIG, loadConfig
  src/group.ts               groupCommits
  src/version.ts             bumpFor, nextVersion
  src/changelog.ts           buildChangelog
  src/render/{markdown,html,json,index}.ts
  test/helpers/fixture-repo.ts
  test/*.test.ts
packages/cli/
  package.json (name chamoji-ai, bin chamoji)  tsconfig.json
  src/run.ts                 run(argv, io) → exit code   (testable)
  src/cli.ts                 #!/usr/bin/env node → process.exit(await run(...))
  test/run.test.ts
```

Deleted: `source/`, `dist/`, `test.tsx`, `package-lock.json`, `.editorconfig` kept, `readme.md` rewritten.

---

### Task 1: Workspace, repo hygiene, fixture helper

**Files:** root config files above, `packages/*/package.json`, `packages/*/tsconfig.json`, `packages/core/test/helpers/fixture-repo.ts`, `packages/core/test/fixture-repo.test.ts`.

**Interfaces:**

- Produces: `createRepo(steps: RepoStep[]): Promise<{ dir: string; cleanup(): Promise<void> }>`, where
  `RepoStep = { commit: string; body?: string; date?: string } | { tag: string; annotated?: boolean } | { mergeBranch: string; commits: string[] }`.
  - Dates default to `2026-01-01T00:00:00Z` plus 1 day per commit.
  - The repo has `user.name`/`user.email` and `commit.gpgsign=false` set locally.
  - `mergeBranch` creates a branch, adds the commits there and merges it with `--no-ff`.

- [ ] Commit a baseline of the current files on `main`, then create branch `milestone-1`.
- [ ] Remove the old files and create the workspace. Run `pnpm install`.
- [ ] Test `createRepo creates commits and tags`: 2 commits and 1 tag. Assert that `git log --oneline` has 2 lines and that `git tag` prints `v1.0.0`.
- [ ] Run `pnpm test`. Expected: PASS. Commit `🎉 Set up pnpm workspace with core and cli packages`.

### Task 2: Gitmojis and commit parsing

**Interfaces:**

- `normalizeEmoji(s: string): string`: removes `️`.
- `GITMOJIS: readonly GitmojiInfo[]`, where `GitmojiInfo = { code: string; emoji: string; description: string; semver: 'major'|'minor'|'patch'|null }`.
- `getGitmoji(code: string): GitmojiInfo | undefined`.
- `findGitmoji(text: string): { code: string; index: number; length: number } | null`. It returns the earliest match in the normalized text, as either `:code:` (code must be known) or unicode.
- `parseCommit(raw: RawCommit): ParsedCommit`.
  - `RawCommit = { hash; shortHash; authorName; authorEmail; date (ISO); subject; body; trailers: string }`.
  - `ParsedCommit = RawCommit` without the `trailers` string, plus:
    - `gitmoji: string|null`, `type: string|null`, `scope: string|null`, `description: string`, `breaking: boolean`
    - `trailers: Trailer[]`, where `Trailer = { key: string; value: string }`.
- Parsing rules:
  - An optional Conventional prefix `^(\w+)(?:\(([^)]+)\))?(!)?:\s*` sets `type`, `scope` and the `!` flag.
  - The gitmoji token is removed from the description.
  - A gitmoji-cli scope `^\(([^)]+)\):\s*` directly after the emoji sets `scope`.
  - If there is no emoji but there is a type, map the type to a gitmoji:

    | type     | gitmoji             |
    | -------- | ------------------- |
    | feat     | sparkles            |
    | fix      | bug                 |
    | docs     | memo                |
    | style    | art                 |
    | refactor | recycle             |
    | perf     | zap                 |
    | test     | white_check_mark    |
    | build    | package             |
    | ci       | construction_worker |
    | chore    | wrench              |
    | revert   | rewind              |

  - `breaking` is true for gitmoji `boom`, the `!` flag, or `/^BREAKING[ -]CHANGE:/m` in the body.

- [ ] Write `gitmojis.test.ts` with these tests:
  - `knows 74 official gitmojis`: `GITMOJIS.length >= 74`, and `getGitmoji('zap').semver === 'patch'`.
  - `findGitmoji matches unicode with and without FE0F`: both `'⚡ x'` and `'⚡️ x'` give `code 'zap'`.
  - `findGitmoji matches :code:`, and ignores an unknown `:nope:`.
- [ ] Write `parse.test.ts`:

  | Test                          | Input                                     | Expected                                                                               |
  | ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
  | `plain gitmoji`               | `'✨ Add login'`                          | `{gitmoji:'sparkles', description:'Add login', type:null, scope:null, breaking:false}` |
  | `shortcode`                   | `':bug: Fix crash'`                       | `gitmoji 'bug'`, `description 'Fix crash'`                                             |
  | `gitmoji-cli scope`           | `'✨ (auth): Add login'`                  | `scope 'auth'`, `description 'Add login'`                                              |
  | `conventional + gitmoji`      | `'feat(auth): ✨ Add login'`              | `type 'feat'`, `scope 'auth'`, `gitmoji 'sparkles'`, `description 'Add login'`         |
  | `conventional only maps type` | `'fix: Handle null'`                      | `gitmoji 'bug'`                                                                        |
  | `breaking via bang`           | `'feat!: ✨ New API'`                     | `breaking true`                                                                        |
  | `breaking via footer`         | body `'BREAKING CHANGE: removed x'`       | `breaking true`                                                                        |
  | `breaking via boom`           | `'💥 Drop node 18'`                       | `breaking true`                                                                        |
  | `no gitmoji`                  | `'Update stuff'`                          | `gitmoji null`, `description 'Update stuff'`                                           |
  | `trailers parsed`             | trailers `'Workstream: auth\nRefs: #4\n'` | `[{key:'Workstream',value:'auth'},{key:'Refs',value:'#4'}]`                            |

- [ ] Run the tests and confirm they fail. Implement `gitmojis.ts` and `parse.ts`. Run again and confirm they pass. Commit `✨ Parse gitmoji and Conventional Commit messages`.

### Task 3: Config, grouping, versioning

**Interfaces:**

- `GroupConfigItem = { group: string; label: string; emojis: string[]; hidden?: boolean }`, `GroupConfig = GroupConfigItem[]`.
- `ChamojiConfig = { groups: GroupConfig; repositoryUrl?: string }`.
- `DEFAULT_GROUP_CONFIG`, in this order: added, changed, breaking_changes, deprecated, removed, fixed, security, useless (`hidden: true`), misc.
  - Every official code appears exactly once across groups. Legacy codes (`apple`, `penguin`, `checkered_flag`, `robot`, `green_apple`) stay in `fixed`.
  - New mapping calls are mine:

    | Group      | New codes                                                                                                                                                    |
    | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | added      | globe_with_meridians, camera_flash, seedling, test_tube, necktie, triangular_flag_on_post, egg, money_with_wings, thread, safety_vest, airplane, stethoscope |
    | changed    | hammer, package, label, mag, dizzy, goal_net, bricks, technologist, page_facing_up, poop                                                                     |
    | deprecated | wastebasket                                                                                                                                                  |
    | removed    | coffin                                                                                                                                                       |
    | fixed      | adhesive_bandage                                                                                                                                             |
    | security   | closed_lock_with_key, passport_control                                                                                                                       |
    | useless    | twisted_rightwards_arrows                                                                                                                                    |
    | misc       | memo, bulb, rocket, construction, beers, busts_in_silhouette, clown_face, see_no_evil, alembic, monocle_face                                                 |

- `loadConfig(cwd: string, explicitPath?: string): Promise<ChamojiConfig>`.
  - It reads `explicitPath` or `<cwd>/chamoji.config.json`. A missing file gives the defaults.
  - A JSON array is a legacy `GroupConfig`. A JSON object is `Partial<ChamojiConfig>` merged over the defaults.
  - Invalid JSON throws `Error('Invalid config <path>: …')`.
- `groupCommits(commits: ParsedCommit[], config: GroupConfig): Group[]`, where `Group = { group: string; label: string; commits: ParsedCommit[] }`.
  - Groups come out in config order. Empty and `hidden` groups are omitted.
  - `breaking` commits go to `breaking_changes` when that group exists.
  - Commits with no matching group go to `misc` when it exists.
- `bumpFor(commits: ParsedCommit[]): 'major'|'minor'|'patch'|null`. Any breaking commit gives major. Otherwise it is the highest gitmoji `semver`.
- `nextVersion(current: string|null, bump): string|null`. This is `semver.inc(current ?? '0.0.0', bump)`. A `v` prefix is accepted and dropped from the output. A null bump returns null.

- [ ] `config.test.ts` has three tests:
  - `every official gitmoji maps to exactly one group`
  - `legacy array config is accepted`
  - `missing file gives defaults`
- [ ] `group.test.ts` has four tests:
  - `groups follow config order and omit empty`
  - `hidden useless group is omitted`
  - `breaking sparkles goes to breaking_changes`
  - `unknown goes to misc`
- [ ] `version.test.ts` has four tests:
  - `boom → major`
  - `sparkles+bug → minor`
  - `only memo → null`
  - `nextVersion('v1.2.3','minor') === '1.3.0'`, and `nextVersion(null,'patch') === '0.0.1'`
- [ ] Run and confirm the tests fail. Implement. Run and confirm they pass. Commit `✨ Group commits by gitmoji and suggest next version`.

### Task 4: Git reader and changelog builder

**Interfaces:**

- `runGit(args: string[], cwd: string): Promise<string>`. Uses `execFile` with `maxBuffer` set to 64 MB, and returns stdout.
- `readCommits(cwd: string, range: string): Promise<RawCommit[]>`.
  - Runs `git log --no-merges --format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%(trailers:only,unfold)%x1e <range>`.
- `listReleaseTags(cwd: string, to: string): Promise<{ name: string; date: string }[]>`.
  - Lists tags with `git tag --merged <to> --format=%(refname:short)%x1f%(creatordate:iso-strict)`.
  - Keeps only `semver.valid` names (a `v` prefix is allowed), sorted newest first with `semver.rcompare`.
- `toWebUrl(remote: string): string | undefined`. Handles `git@host:o/r.git`, `ssh://git@host/o/r.git` and `https://host/o/r(.git)`, and returns `https://host/o/r`.
- `getRemoteWebUrl(cwd): Promise<string|undefined>`. Reads `origin`, and returns undefined when there is no remote.
- `buildChangelog(opts: { cwd: string; config: ChamojiConfig; to?: string; from?: string; release?: string; today?: string }): Promise<Changelog>`.
  - `Changelog = { repositoryUrl?: string; releases: Release[] }`.
  - `Release = { version: string; tag: string|null; previousTag: string|null; date: string|null; bump; nextVersion: string|null; groups: Group[] }`.
- Build rules:
  - Releases are listed newest first.
  - The Unreleased range is `<latestTag>..<to>`, or all of `<to>` when there is no tag. It is included only when it has commits. Its `version` is `opts.release` or `'Unreleased'`, and its date is `opts.release ? today : null`.
  - Each tag's range is `<olderTag>..<tag>`, or all of `<tag>` for the oldest.
  - `from` stops the list before the release whose tag equals `from`.
  - `date` is the `YYYY-MM-DD` part of the tag date.
  - `repositoryUrl` is `config.repositoryUrl ?? getRemoteWebUrl`.
  - Running outside a git repo throws `Error('Not a git repository: <cwd>')`.

- [ ] `git.test.ts` has three tests:
  - `toWebUrl variants`: 4 cases.
  - `readCommits returns body and trailers and skips merges`: built with `mergeBranch`.
  - `listReleaseTags sorts prereleases by semver`: tags `v1.0.0-rc.1`, `v1.0.0` and `not-a-version` give `['v1.0.0','v1.0.0-rc.1']`.
- [ ] `changelog.test.ts` has five tests:
  - `releases newest first with correct ranges`: v1.0.0 (2 commits), v1.1.0 (1), then 1 unreleased. Assert versions `['Unreleased','v1.1.0','v1.0.0']` and the commit counts.
  - `no tags gives single Unreleased`.
  - `release option names unreleased and dates it`.
  - `from option stops before tag`.
  - `outside git repo throws`.
- [ ] Run and confirm the tests fail. Implement. Run and confirm they pass. Commit `✨ Build releases from git tags and history`.

### Task 5: Renderers

**Interfaces:**

- `renderMarkdown(c: Changelog): string`
- `renderHtml(c: Changelog): string`
- `renderJson(c: Changelog): string`
- `render(c, format: 'markdown'|'json'|'html'): string`

Output format, decided here:

- Markdown starts with `# Changelog\n`. Each release then follows this layout:

  ```
  ## [<version>](<url>/compare/<previousTag>...<tag>) - <date>
  ```

  - The link is only added when `repositoryUrl`, `tag` and `previousTag` all exist. The Unreleased compare link targets `HEAD`.
  - The ` - <date>` part is left out when there is no date.

- Each group is a `### <label>` heading followed by `- <emoji> <scope bold?> <description> ([<shortHash>](<url>/commit/<hash>))`.
  - With a scope, the line reads `**scope:** description`.
  - `#123` becomes `[#123](<url>/issues/123)` when there is a URL.
  - `<` and `>` in descriptions become `&lt;` and `&gt;`.
- HTML is a full document with `<meta charset="utf-8">`. All text goes through `escapeHtml` (`& < > " '`), and links are `<a href>`.
- JSON is `JSON.stringify(c, null, 2) + '\n'`.

- [ ] `render.test.ts` has five tests:
  - `markdown matches snapshot`: uses a hand-built `Changelog` with a URL, and calls `toMatchInlineSnapshot`.
  - `markdown without url has no links`.
  - `markdown escapes angle brackets`.
  - `html escapes script tag`: `'<script>'` must not appear, and `'&lt;script&gt;'` must.
  - `json round-trips`.
- [ ] Run and confirm the tests fail. Implement. Run and confirm they pass. Commit `✨ Render changelog as Markdown, HTML and JSON`.

### Task 6: CLI

**Interfaces:**

- `run(argv: string[], io: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void; today?: string }): Promise<number>`.
- Commands:
  - `chamoji changelog [--format markdown|md|json|html] [--output <file>] [--from <tag>] [--to <ref>] [--release <version>] [--config <file>]`. Without `--output` it prints to stdout. With `--output` it writes the file and prints `Wrote <file>` to stderr.
  - `chamoji next-version [--to <ref>]`. Prints the suggested next version, or `none` and exit code 0 when no bump applies.
  - No command, or an unknown one, prints help and exits with 2 (help via `--help` exits 0).
  - Errors print `chamoji: <message>` to stderr and exit with 1.

- [ ] `run.test.ts` has four tests:
  - `changelog json on fixture repo`: parse stdout and check the versions.
  - `--output writes file`.
  - `next-version prints minor bump`: `v1.0.0` plus one `✨` commit gives `1.1.0`.
  - `outside repo exits 1 with message`.
- [ ] Implement `run.ts` and `cli.ts`, using `meow(help, { argv, importMeta, flags })`. Run the tests and confirm they pass.
- [ ] Rewrite `readme.md` to cover install, the commands, the config format and the gitmoji/Conventional support.
- [ ] Commit `✨ Add changelog and next-version commands`.

### Task 7: Verify on real repos

- [ ] Run `pnpm build && pnpm check && pnpm test`. All three must pass.
- [ ] Clone `carloscuesta/gitmoji` and `carloscuesta/gitmoji-cli` with `--filter=blob:none` into the scratchpad. Run `node packages/cli/dist/cli.js changelog --to HEAD` in each.
  - Check by eye: releases exist, sections are filled, and almost nothing lands in Misc.
  - Record the release, commit and Misc counts.
- [ ] Generate chamoji's own `CHANGELOG.md`. Commit `📝 Add generated changelog`.
