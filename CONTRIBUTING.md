# Contributing to chamoji

Thanks for helping. Chamoji writes its own changelog from this repo's history, so how commits are written matters here.

## Setup

```bash
pnpm install
pnpm test     # vitest
pnpm check    # build, type-check (including tests) and prettier
```

Node.js 22 or newer and git are required. `packages/core` is the engine and `packages/cli` is the `chamoji` command. [`docs/ROADMAP.md`](docs/ROADMAP.md) says what we're building next.

## Commit messages

```
<gitmoji> <Title in the imperative>

<Optional body: what changed and anything surprising.>

Why: <Optional one line on the reason, if the title doesn't make it obvious.>
```

- **Start with one [gitmoji](https://gitmoji.dev).** It picks the changelog section and the version bump:

  | Gitmoji | Section          | Bump  |
  | ------- | ---------------- | ----- |
  | ✨      | Added            | minor |
  | 🐛      | Fixed            | patch |
  | ♻️      | Changed          | none  |
  | 📝      | Documentation    | none  |
  | 🔒️      | Security         | patch |
  | 💥      | Breaking changes | major |

  Pick from the [full list](https://gitmoji.dev).

- **Write the title as an instruction:** "Add …", "Fix …", "Remove …", not "Added" or "Fixes". It appears in the changelog as written.
- **Breaking changes:** use 💥, or add a `BREAKING CHANGE: …` footer explaining what users must do.
- **`Why:`** is optional, but write one whenever the reason isn't obvious from the title. Milestone 7 (project memory) builds on these lines, and they help reviewers now.
- **AI-assisted commits:** keep the `Co-Authored-By:` trailer your tool adds, so reviewers can tell.
- **One logical change per commit.** If the title needs "and", consider splitting it.

To preview what your commits will look like in the changelog:

```bash
pnpm build && node packages/cli/dist/cli.js changelog | head -40
```

## Pull requests

- Write tests first, then make them pass, and keep `pnpm check` green.
- If you change commit parsing, run chamoji on the benchmark repos listed in the roadmap, and put the before and after numbers in the PR.
- Never commit secrets. `.env` and `.env.*` files are git-ignored; put `TYPESAFE_API_KEY` in `.env.local`.

## Releases (maintainers)

```bash
pnpm release --dry-run   # builds, then shows the next version and its changelog section
pnpm release             # builds, then runs `chamoji release`: CHANGELOG.md, both packages, commit and tag
git push --follow-tags
pnpm publish -r
```

- `pnpm release` is `chamoji release` from this checkout, so it runs only on `main` (origin's default), with a clean working tree.
- It picks the version with `chamoji next-version`. When nothing since the last tag needs a release, it stops with exit code 3 and changes nothing.
