# Monorepo releases and `chamoji setup`

**Date:** 2026-11-03
**Status:** design, waiting for approval
**Milestone:** 7.5 in [`docs/ROADMAP.md`](../../ROADMAP.md). This design replaces the scope written there.

## Intent

Today `chamoji release` treats a repo as one thing. It works out one version, bumps every tracked manifest that carries the previous version, writes one root `CHANGELOG.md` and makes one `v*` tag. That suits chamoji-ai, whose two packages ship together. It's wrong for most monorepos, including nearly every monorepo Alec works in.

This milestone does two things:

1. **Releases per unit.** A monorepo can release each thing it ships on its own: a web app and a mobile app with their own versions, tags and changelogs, or each published package of a library monorepo. Internal packages that nobody ships on their own don't get versions, but their changes still reach the release notes of the units that use them.
2. **`chamoji setup`**, an interactive command that works out how the repo is laid out and how it has been released so far, asks only what it can't work out, writes the answers to `chamoji.config.json`, and shows what the next release would look like before anything is saved. It's also the one first-run command: today's `chamoji init` (memory sharing), `init --agents` and `hook install` become steps inside it.

**The idea behind the design:** other release tools make you adopt their conventions, and the grief starts when your history doesn't match. Chamoji does the reverse. The repo's own history is the spec. Setup learns the repo's tags, changelog style and layout and keeps them, so a developer who has tagged releases their own way for years can keep doing so.

## Who it serves

Evidence comes from a read-only scan, on 2026-11-03, of the 45 monorepos in Alec's `~/Documents/GitHub`, plus web research on how other teams version apps.

**App monorepos (Alec's case, and most of the 45).** About 40 are SaaS apps built on the Makerkit starter (krafterp, gearz-deploy-40, klare, celestial-salon, autoify-car-club and others):

- 35 to 58 packages each, about 97% of them `private`.
- Almost every package is still at the template's `0.1.0`, and every internal dependency uses `workspace:*`. Nothing is published to npm.
- What ships is `apps/web`, sometimes with `apps/mobile` (Expo) and `apps/worker`. **Each app has its own version** (Alec's words: "a mobile app can have its own version, and a web app can have its own version").
- About 25 of them carry 24 to 162 tags such as `4.0.2` and `5.0.0` that came from Makerkit's upstream history. Their commits are authored by Makerkit's maintainer, and they reach the clone through an `upstream` remote. Today chamoji would read Makerkit's `5.0.0` as the app's last release. Stray tags such as `wip/crm-pipeline-stages` also appear.
- Commits cross packages all the time. In four repos, `apps/web` is in 75 to 80% of Alec's commits, 30 to 60% of commits touch two or more packages, and 7 to 17% touch only root files. `apps/e2e`, a test app, appears often.
- Commit styles are mixed within a repo: Conventional from 10% to 90%, gitmoji up to 80%, and scopes (`feat(web):`) mostly under 25%.
- Almost none has a `CHANGELOG.md`. gearz-deploy-40's `apps/mobile` has one.
- gearz-deploy-40's Expo app keeps its version in `apps/mobile/app.config.ts` (code, not JSON) and `package.json`. Its build number is managed by EAS (`appVersionSource: remote`, `autoIncrement: true`).

**Apps released together.** Some teams give web and mobile different numbers but release them as one ([Abyss ADR 022](https://abyss.uhc.com/adrs/decisions/adr-022-separate-versioning-mobile-web): one tag lists both versions).

**Apps that deploy continuously.** Some teams prefer date versions such as `2026.11.0` for apps and semver for shared code.

**Library monorepos.** Each published package has its own version, as with changesets. neatsuite uses changesets with an `ignore` list, two public packages that share `2.1.3`, plain `2.1.3` tags and one changeset file that was never consumed. chamoji-ai itself uses fixed versions.

**Tags seen in the wild, which must all be readable:**

| Format                                                   | Where it was seen          |
| -------------------------------------------------------- | -------------------------- |
| `@calcom/atoms@1.2.3`                                    | changesets style (cal.diy) |
| `twenty/v1.2.3`, `sdk/v1.2.3-alpha.1`, `npm-release/N-N` | twenty                     |
| `@oracle/suitecloud-cli@3.1.2`                           | netsuite-suitecloud-sdk    |
| plain `2.1.3`, four-part `1.2.3.4`, `v1.2.3-1`           | Makerkit-based repos       |
| `v1.2.3` and `v1.2.3-beta.4` across 42 fixed packages    | payload-kit                |

## Goals

- Each app in an app monorepo gets its own version, tags and changelog, with no extra files to write per change.
- Changes to internal packages appear in the notes of the apps that use them, once each.
- Any existing tag format keeps working. Setup reads every format it finds, writes new tags in the format the developer picks, and never asks for a tag to be renamed or deleted.
- First run is a few presses of Enter: setup works out the answers and asks only what it can't.
- The developer sees what each choice does to their next release before saving it.
- Library monorepos get independent versions per published package, with fixed groups and dependency ranges.
- Commits that came from a template or upstream, such as Makerkit's, never flood an app's notes.

## Non-goals (this milestone)

- **Publishing to npm.** That's milestone 7.6.
- **Workspaces other than npm, pnpm, Yarn and Bun.** Cargo workspaces, uv, Poetry and Go come later.
- **A release-PR mode** (a bot PR that collects the next release for review), migrating from other tools, `setup --check` in CI, and keeping hand edits to generated changelog text. These are listed in phase 3 below. They're designed for but not built here.
- **Changing what a single-package repo gets.**
- **Building the `train` and `mixed` shapes** (Alec's decision). Setup can recognise them and say they're coming, and the config leaves room for them, but this milestone builds `single`, `apps` and `libraries`. Two questions stay open for the milestone that builds them: whether a train's product version is separate from each app's version and what bumps it, and whether a commit to a published library counts as a shared commit for an app in the same repo that uses it.

## Anti-goals

These would make it a failure even if it works:

- **Breaking an existing repo.** A repo that never runs setup getting a different version, tag, changelog, commit or `--json` from `chamoji release` than 0.12.0 gives it.
- **Rewriting history.** Deleting, moving or renaming a tag, or rewriting old changelog entries.
- **Grief over tags.** Refusing to work, or forcing a migration, because a repo's tags don't match a convention.
- **Silently cutting a wrong release.** An older chamoji, for example one pinned in the Action, misreading newer settings and releasing all units as one.
- **Noise.** A `CHANGELOG.md` in each of 50 internal packages, the same line repeated in an app's notes release after release, or a test app getting releases.
- **AI deciding.** Detection reads git and files only. Jev may suggest; it never decides.

## Constraints

- The roadmap's principles apply: deterministic and offline without `--ai`, AI never decides for the author, context lives in git, send as little as possible.
- Works on macOS, Linux and Windows, as the CI matrix checks today.
- Interactive screens follow the terminal-face rules: stderr only, no animation when stderr isn't a terminal, in CI, with `TERM=dumb`, with `--json` or with `CHAMOJI_NO_ANIMATION=1`. The look follows `docs/brand/BRAND.md`.
- Manifests are edited as text, as `bumpManifest` does today, so formatting survives.

## Concepts

- **Release unit:** something that gets its own version, tags, changelog and GitHub release: an app, a published package, or a fixed group of packages. A unit has a short name taken from its folder (`web`, `mobile`), which the developer can change and which every command uses (`--unit web`).
- **Internal package:** a workspace package that isn't a unit. It never gets a version bump, tag or changelog file of its own.
- **Excluded path:** a package or folder that never releases and never contributes, such as `apps/e2e` or `tooling/*`.
- **Which apps are units:** setup shows every package under the workspace's app folders (`apps/*` by default, or any folder whose packages nothing else depends on) as a candidate, and the developer ticks the ones that ship. It ticks them all except names that look like tests or tools: `e2e`, `test`, `tests`, `playwright`, `cypress`, `storybook`, `docs` and `dev-tool`. An app that isn't ticked is excluded, never internal, so its commits are never silently lost: they appear nowhere, and `--dry-run` says so in one line. In gearz-deploy-40 that gives web and mobile as units, with `e2e` and `dev-tool` excluded. _(My call.)_
- **Uses:** unit U uses internal package P when P is in U's `dependencies` or `peerDependencies`, directly or through other internal packages. `devDependencies` don't count, so tooling such as a shared eslint config doesn't pull its commits into an app's notes. _(My call: an app's dev tools don't ship to its users.)_
- **Shape:** what the repo releases, which is the first thing setup settles.

| Shape            | Units                                  | Versions                                        | Default tag         |
| ---------------- | -------------------------------------- | ----------------------------------------------- | ------------------- |
| `single` (today) | the repo                               | one                                             | `v{version}`        |
| `apps`           | each app                               | semver or dates, per app                        | `{unit}/v{version}` |
| `train`          | the product                            | one release whose notes list each app's version | `v{version}`        |
| `libraries`      | each published package, or fixed group | semver, independent or grouped                  | `{name}@{version}`  |
| `mixed`          | apps and published packages            | per unit                                        | per unit            |

## How releases work

### Which commits belong to which unit

A commit's files decide it. A scope or emoji never overrides the files.

- **Own commit:** it changes a file under the unit's path.
- **Shared commit:** it changes a file in an internal package the unit uses, and nothing under the unit's path.
- A commit that changes several units' paths is an own commit for each of them.
- **Root-only commit:** it changes only files outside every package, such as the lockfile, CI or root config. The `rootFiles` setting decides what happens: `none` (left out everywhere; the default for `apps` and `libraries`), `all` (an own commit for every unit), or `note` (one summary line, "Tooling and CI: 12 changes", in each unit's notes).
- Commits that change only excluded paths are left out.

A unit's **window** is the commits since the unit's own last tag. A unit with no tag of its own starts at the repo's starting point (below), or at its first commit when there is none.

### Upstream history: templates and forks (Alec's decision)

Many of Alec's apps began as a clone of the Makerkit starter and keep pulling its updates through an `upstream` remote. In gearz-deploy-40, about 737 of `apps/web`'s 1,418 commits are Makerkit's, and every sync brings more. Those commits are left out, and each sync becomes one line.

- **Starting point:** setup records where the repo's own history starts (`upstream.since`): the first commit that isn't part of the upstream history. Upstream commits before it are never in any unit's notes.
- **Upstream commits** are commits that are reachable from the upstream remote's branches, or from an ignored inherited tag when there is no remote. They're left out of every unit's notes and never release anything by themselves, wherever they appear, including after the starting point.
- **A sync** is a merge commit that brings upstream commits in. It counts as one own commit, with the patch level, for each unit whose files the merge changed compared with its first parent. Its line names the base and the newest inherited tag the merge brings in: "Updated the Makerkit base to 4.0.2". Without such a tag, it gives the merged commit's short hash. A unit whose files a sync changed releases on the next run, like any other own commit.
- **The base's name** (`upstream.name`, here "Makerkit") is asked once by setup, which suggests the remote's repo name.
- A repo with no upstream remote and no inherited tags has no starting point, and none of this applies.
- How setup finds the starting point and the syncs is the builder's, within these rules. A squash-merged sync, which is no longer a merge commit, counts as an ordinary own commit, and setup says so when it sees one.

### Shared changes ride along (Alec's decision)

- A shared commit never releases a unit on its own. A unit releases only when its window has at least one own commit.
- When the unit releases, its notes include every shared commit in its window, under its usual sections, each marked as coming from a shared package (for example "via `packages/supabase`"). Since the window starts at the unit's last tag, each shared change appears once per unit, in the first release of that unit that ships it.
- Example from gearz-deploy-40: a commit to `packages/supabase` alone releases nothing. The next commit to `apps/web` releases web, and web's notes carry both. Mobile doesn't release until it has a change of its own, and then its notes carry the supabase change too.
- **Escape hatch:** a `Release: <unit>` trailer on a commit (repeatable, or `Release: all`), or `chamoji release --unit mobile`, releases a unit even when its window has only shared commits. This is for a fix in a shared package that has to ship now, such as a security fix in auth.
- **Other teams:** `sharedChanges: "release-dependents"` makes a shared commit release every unit that uses it, as library tools such as changesets do. Setup asks, with ride-along as the recommended answer for `apps` and release-dependents for `libraries`.

### Versions

- Each unit's bump comes from every commit in its window, own and shared, using today's rules for breaking changes, features and fixes. _(My call: a breaking change in a shared package is breaking for the app that ships it.)_
- **First release of a unit:** a unit with no tag of its own releases the version already in its manifest, as is (`web/v0.1.0`), unless setup recorded another starting version for it (`"firstVersion": "1.0.0"`). Setup asks this once per unit with no tag: "web is 0.1.0 in package.json; start there or at 1.0.0?". Later releases bump from there. A single-unit repo keeps today's behaviour, which asks for the version. _(My call, from the conversation: an app's manifest is where its version already lives.)_
- **When a tag and a manifest disagree:** the unit's latest tag is its current version, since that is what was released. On release, every version file the unit lists is set to the new version, whatever it said before, and `--dry-run` names any file that disagreed. Setup points out the mismatch when it finds one. _(My call: hand-tagged repos often never bumped their manifests, and refusing would block exactly the repos this milestone is for.)_
- **0.x packages:** `zeroMajor: "minor"` makes a breaking change bump the minor version while the major is 0. Setup asks this only when a unit is at 0.x, with "minor" recommended. Without the setting, today's behaviour stays.
- **Date versions** (`versioning: "calver"`, per unit): `YYYY.MM.N`, where N counts that unit's releases within the month, starting at 0. It's a valid semver string, so the tools around it keep working.
- **Fixed groups** (libraries): the units in `groups: [["core", "cli"]]` always share one version: the largest bump of any of them. When any unit in the group releases, all of them do.
- **Dependency ranges** (libraries): when a published package releases, packages that depend on it get the new range, and a patch release with a Dependencies line under `sharedChanges: "release-dependents"`, the default for libraries. Under ride-along, a dependent's range is updated only in a release of that dependent, never on its own. _(My call: a manifest change with no release of its own would leave the package's published range and its source out of step.)_ `workspace:` ranges are left alone, since pnpm rewrites them at publish time.

### Where versions are written

Setup finds every place a unit's current version is written, and `release` bumps them together. If it can't find the current version in a file the config lists, it stops before changing anything.

- `package.json`, plus `package-lock.json`'s root entry, as today.
- Expo: `app.json` (`expo.version`) and `app.config.ts`/`app.config.js` (the first `version:` property, edited as text).
- Bare React Native: `ios/**/Info.plist` (`CFBundleShortVersionString`) and `android/app/build.gradle` (`versionName`).
- Any other file listed in the unit's `versionFiles`, for example a `VERSION` constant or a version in the README. Setup offers files where it finds the current version string.

**Build numbers** (`CFBundleVersion`, `versionCode`, Expo's `buildNumber` and `versionCode`) are never touched by default. When EAS's `appVersionSource` is `remote`, chamoji doesn't touch them at all, and setup says so. When it's `local`, setup offers `buildNumber: "increment"`, which raises them by one on each release of that unit.

### Tags

- **Writing:** each unit has a tag template, such as `web/v{version}`, `{name}@{version}` or `v{version}`. `{unit}` is the short name, `{name}` the package name and `{version}` the version. One release commit can carry several annotated tags.
- **Reading:** to find a unit's last release, chamoji reads every tag that matches its template or one of the unit's learned formats (`read`). So `web-v1.2`, a missing patch number and a mix left over from a half-finished migration all still count. Tags are compared as versions, with missing parts read as 0.
- **Aliases:** a tag that can't be parsed but is a real release gets one line, for example `"final-release": "1.0.0"`, scoped to a unit.
- **Ignored tags:** patterns in `tags.ignore` never count as releases. This is how inherited tags and stray tags such as `wip/*` are handled. They stay in git, untouched.
- **Inherited tags:** setup flags tags that look like they came from a template or upstream, and offers to ignore them, with a count and examples. Signs include a tag that is reachable from an `upstream` remote's branches, a tag whose commit and its recent ancestors are authored only by people who never commit after the fork, and a tag older than the first commit by anyone in the repo's current authors. The exact rule is the builder's, and the developer always confirms.
- **chamoji's own release detection keeps working:** `releaseSubject` still words the release commit so chamoji leaves it out of later changelogs.

### Changelogs

- **Apps:** one `CHANGELOG.md` in each app's folder. **Libraries:** one in each published package's folder. **Train:** one root `CHANGELOG.md`, with a line per app version under each release. **Internal packages never get one.**
- An optional root changelog for `apps` and `libraries` lists each release with links to the units' changelogs (`rootChangelog: true`).
- **Matching the existing style:** when a unit's changelog already exists, new entries copy its heading format, date format, section names and link style, taken from its latest entry. With no changelog, chamoji's own format is used, as today.
- Workstreams: a shipped workstream whose commits reach several units becomes a Highlight in each of them.

### GitHub releases

One per unit tag by default. `githubReleases: "combined"` makes one release per release commit, listing every unit released. That's the default for `train`.

## Commands

### `chamoji setup`

The first-run command for a repo, and the way to change settings later. It runs four steps, each skippable:

1. **Releases:** what this milestone adds.
2. **Memory sharing:** today's `chamoji init`.
3. **AI agents:** today's `init --agents` (the `.mcp.json` server and the Claude Code hook). It's offered only when Claude Code or a `.claude/` folder is found.
4. **Commit composer:** today's `hook install`. It's offered, not assumed.

**First screen:** a summary of what setup found and what it recommends. For example:

> Found 4 apps (web, mobile, e2e, dev-tool) and 39 internal packages. web and mobile get their own versions; e2e, dev-tool and tooling are left out. 162 tags look like they came from Makerkit and will be ignored. Shared changes ride along with each app's own releases.

Enter accepts everything. "Change something" opens only the question picked. Every question shows what chamoji found, with a recommended answer, and a question it can answer from the repo isn't asked. Root-only commits, for example, are asked about using that repo's own examples ("12 commits since your last release touched only `pnpm-lock.yaml` or `.github/`").

**Live preview:** while setup is open, the screen shows the next release for each unit under the current answers: its version, its tag and the first lines of its notes. The preview changes as the answers change. On a terminal too narrow for two columns it goes under the questions.

**Replay before saving:** setup applies the answers to each unit's recent releases, up to five, and shows how each would have come out next to what was actually released. For example: "web v2.3.0: you shipped 14 entries; chamoji would write 15, and the extra one is a CI commit." A repo with no past releases of its own skips this step.

**Squash-merge check:** with `gh` available and a GitHub remote, setup reads the repo's merge settings. If squash merges keep only the PR title, which drops `Release:`, `Workstream:` and intent-card trailers, it says which setting keeps the body.

**Running it again** shows each step's state ("✓ memory sharing is on in this clone") and changes only what's picked. Repo-wide settings (`chamoji.config.json`, `.mcp.json`) are committed and shared. Memory sharing and the hook are per clone. So in a clone of a repo that's already set up, setup asks only the per-clone steps, which is why a README can tell new contributors to run `chamoji setup`.

**Subcommands** run one step: `chamoji setup releases`, `setup memory`, `setup agents` and `setup hook`. **`--yes`** takes every recommended answer with no prompts, for CI, agents and scripts. **`--json`** reports what was found and done. Without a terminal and without `--yes`, setup prints what it would do and exits 2 without writing.

**What it writes:** the `release` section of `chamoji.config.json`, plus whatever the other steps write today. It never commits; the developer reviews the file and commits it. `git restore chamoji.config.json` undoes the releases step.

### Other commands

- **`chamoji init`** keeps its exact output, flags and exit codes. It's equivalent to `chamoji setup memory --yes` (and `init --agents` to memory plus agents). After it finishes, it suggests `chamoji setup` once, for the steps it doesn't cover.
- **`chamoji release`** in a repo with units releases every unit that has something to release, in dependency order, as one release commit with one tag per unit. `--unit <name>` (repeatable) releases only those units, and works as the escape hatch. `--dry-run` prints a table of unit, old version, new version, bump and commit count. `--json` adds a `units` list and keeps every field it prints today.
- **`chamoji next-version`** prints one line per unit, including shared changes that are waiting: "mobile: no changes of its own; 3 shared changes ride along with its next release". In a single-unit repo its output doesn't change.
- **`chamoji changelog`** takes `--unit <name>`.
- **The commit composer** shows the impact of the staged files: "releases with: web · rides along to: mobile". It offers to add a `Release:` trailer.
- **Bare `chamoji`** in a repo that has never been set up adds a line to the welcome screen: "Run `chamoji setup` to get started."
- **The Action:** `mode: release` keeps working and gains an optional `unit` input. The PR comment lists each unit the PR would release and its next version. Notes on a tag push go to that unit's GitHub release.

## Configuration

Setup writes a `release` section into the existing `chamoji.config.json`, alongside the changelog-section settings already there. An example for gearz-deploy-40:

```json
{
	"release": {
		"schema": 1,
		"shape": "apps",
		"units": {
			"web": {"path": "apps/web", "tag": "web/v{version}"},
			"mobile": {
				"path": "apps/mobile",
				"tag": "mobile/v{version}",
				"versionFiles": ["apps/mobile/app.config.ts"],
				"buildNumber": "untouched"
			}
		},
		"exclude": ["apps/e2e", "apps/dev-tool", "tooling/*"],
		"sharedChanges": "ride-along",
		"rootFiles": "none",
		"zeroMajor": "minor",
		"upstream": {"remote": "upstream", "name": "Makerkit", "since": "<commit>"},
		"tags": {
			"ignore": ["^\\d+\\.\\d+\\.\\d+$", "^v\\d+\\.\\d+\\.\\d+-\\d+$", "^wip/"]
		}
	}
}
```

- The names and defaults above are decided. The full schema, validation and error wording are the builder's.
- **`schema`** guards against CLIs that are too old. A chamoji that finds a `release.schema` higher than it knows stops before changing anything, with "this repo's release settings need chamoji <version> or newer" and exit code 2.
- **0.12.0 can't be guarded from new code, so the gap is closed in two places and documented.** The builder confirmed that 0.12.0 accepts a `release` section silently. It also reads only tags that are valid semver, so a pinned 0.12.0 would cut one whole-repo release, starting from an inherited `5.0.0`. So:
  - The next patch, 0.12.1, refuses any `release` section with the same message. It ships before this milestone.
  - The Action's script, which is versioned separately from the CLI, refuses to run a CLI older than the version that ships this milestone when a `release` section exists.
  - The Action's `notes` mode stops editing a GitHub release for a tag that doesn't look like a whole-repo version tag, so a unit tag such as `web/v1.3.0` never gets whole-repo notes from an old Action ref.
  - The release notes for this milestone and the readme say that anyone who pins the CLI must move to that version before running setup.

  Nothing in `chamoji.config.json` is shaped to make 0.12.0 throw. _(My call: such a trick would show in everyone's file and outlive its purpose.)_

- Settings stay valid JSON with no comments. `chamoji setup --explain` (or a `why` column in `--json`) says where each value came from: detected, recommended, or chosen.

## Backwards compatibility

1. **No `release` section means 0.12.0 behaviour, byte for byte:** the same versions, tags, changelog, release commit, `--json` and `next-version` output. That covers chamoji-ai, single-package repos and every monorepo that never runs setup. A test compares against 0.12.0 output on fixture repos.
2. **Chamoji never switches mode by itself.** In an unconfigured monorepo, `release` and `next-version` may print one note on stderr that setup can version each app. It's printed once per clone, and never under `--json` or in CI.
3. **Commands and flags are only added.** `init`, `hook install`, `release` and the Action's inputs keep their meaning.
4. **`--json` output only gains fields.**
5. **Old tags always count**, through templates, learned formats, aliases or ignore patterns.

## Order of work

1. **Phase 1: the engine.**
   - Workspace and unit detection.
   - The config, with schema validation and the old-CLI guard. The 0.12.1 refusal ships first, on its own.
   - Commit-to-unit mapping, ride-along and the escape hatch.
   - Upstream history: the starting point, leaving out upstream commits, and one line per sync.
   - Per-unit versions, including date versions and `zeroMajor`.
   - Library monorepos: independent versions per published package, fixed groups, dependency ranges and `release-dependents`.
   - Version files, including Expo and React Native.
   - Tag templates, reading, aliases and ignore patterns.
   - Per-unit changelogs that match the existing style.
   - `release`, `next-version` and `changelog` with `--unit`.
   - The Action's `unit` input and its per-unit PR comment.

   With a hand-written config, this phase is useful on its own.

2. **Phase 2: `chamoji setup`.**
   - Detection of the shape and of inherited tags.
   - The summary screen and the questions.
   - The live preview and the replay.
   - The four steps, reusing `init` and `hook install`.
   - `--yes`, `--json`, the squash-merge check and the composer's impact line.
3. **Phase 3: later releases, designed for but not built here.**
   - The `train` and `mixed` shapes, once their open questions are settled.
   - Migration from changesets, release-please, Lerna, Nx and semantic-release configs, including consuming pending changeset files.
   - `chamoji setup --check` for CI drift (a new package with no settings, a version file out of sync, a tag off-format, `workspace:` about to be published).
   - A release-PR mode for protected branches.
   - Keeping hand edits to generated changelog lines, stored in git against the commit.

## Exit criteria

- **Byte-for-byte compatibility:** with no `release` section, `release --dry-run --json`, `release`, `next-version` and `changelog` match 0.12.0 on chamoji-ai and on a single-package fixture.
- **Ride-along:** on a fixture app monorepo with web, mobile, a shared package and an e2e app:
  - a shared-only commit releases nothing
  - web's next release carries the shared commit once
  - mobile's first later release carries it once
  - e2e never releases
  - `Release: mobile` releases mobile alone
- **Tags:** a fixture with mixed historical tags (`web-v1.2`, `web/v1.3.0`, an unparseable tag with an alias, and 30 inherited plain-semver tags) finds the right last release for each unit, writes the next tag in the chosen format, and leaves every existing tag in place.
- **Upstream:** on a fixture cloned from a template with 30 upstream commits, two inherited tags and one sync merge, web's first release leaves every upstream commit out and shows the sync as one line naming the newest inherited tag.
- **Libraries:** on a fixture with three published packages, where `cli` depends on `core` and `core` and `types` are a fixed group, a fix in `core` releases `core` and `types` at the same version, gives `cli` the new range and a patch release with a Dependencies line, and leaves `workspace:` ranges alone.
- **Mobile:** an Expo fixture bumps `app.config.ts` and `package.json` together, and leaves build numbers untouched when `appVersionSource` is `remote`.
- **Setup:** on a copy of gearz-deploy-40's layout, `chamoji setup --yes` finds web and mobile as units, excludes e2e, dev-tool and tooling, ignores the Makerkit tags, and writes a config that `release --dry-run` accepts. Interactive setup reaches a saved config with one Enter when every answer is detected.
- **Real use:** Alec releases web and mobile separately from one of his app monorepos, and chamoji-ai keeps releasing as before.
- **Platforms:** CI passes on Ubuntu, macOS and Windows.

## Decided by Alec

- Each app in an app monorepo has its own version: "a mobile app can have its own version, and a web app can have its own version." Other teams may differ, so the shapes above cover them, validated by the research cited in "Who it serves".
- A change to a shared package appears in an app's notes when that app releases with code changes of its own and uses the package (ride-along), not in every app that uses it.
- Developers keep their existing tag formats with no grief from chamoji.
- `init` becomes a step of `setup`, not the other way round.
- Upstream commits from a template such as Makerkit are left out after a starting point that setup records, and each upstream sync is one line that releases the apps it touched, as a patch.
- This milestone builds `single`, `apps` and `libraries`. `train` and `mixed` are designed for and come later.
- Setup is interactive, writes a real configuration, and covers the problems found with today's tools: changesets, release-please, semantic-release, Lerna and Nx.

## My calls (marked in the text)

- `devDependencies` don't count as "uses".
- A breaking change in a shared package is breaking for the unit that ships it.
- Root-only commits are left out by default for `apps` and `libraries`.
- Build numbers are untouched unless `buildNumber: "increment"` is set.
- `{unit}/v{version}` is the default tag for apps. It's the format seen most often in the research (kitty, twenty, path-based tags).
- Date versions are `YYYY.MM.N`.
- Setup never commits.
- A unit's first release uses its manifest version unless setup recorded another.
- A unit's latest tag wins over its manifests.
- 0.12.0 is guarded by 0.12.1 and the Action, not by a trick in the config.
- Apps that look like tests or tools are left unticked, and unticked apps are excluded.
- Under ride-along, a dependent's range changes only in a release of that dependent.

## Left to the builder

- The config's full schema and validation messages.
- The inherited-tag heuristic, within the signs listed above.
- How setup finds the starting point and the syncs, within the upstream rules.
- The layout and key bindings of the setup screen, within `BRAND.md`.
- How style-matching reads an existing changelog's latest entry.
- How the replay lines up a past release with what chamoji would have produced.
- Test fixture design.
