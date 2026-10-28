# Changelogs on autopilot (GitHub Actions)

Pick the workflow that matches how the team ships, adapt it to the repo, and commit it under `.github/workflows/`.

| Workflow         | When it runs                                              | What it does                                                                                |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Release workflow | Someone clicks **Run workflow**, or on every push to main | Picks the version, writes CHANGELOG.md, bumps, commits, tags and creates the GitHub release |
| Notes workflow   | Someone pushes a `v*` tag                                 | Only creates the GitHub release notes                                                       |

These apply to both:

- **Clone the full history:** set `fetch-depth: 0`. A shallow clone has no tags, so chamoji would treat the whole history as one unreleased blob.
- **Pass inputs through `env`:** never paste `${{ inputs.* }}` straight into `run:` scripts, where they can inject shell commands.
- **Pushes made with `GITHUB_TOKEN` don't trigger other workflows.** A separate "publish on tag" workflow won't fire for a tag this job pushes. Either publish in the same job, or push with a GitHub App or fine-grained token.

## Release workflow

Copy `scripts/release.mjs` from this skill into the repo, for example as `scripts/release.mjs`, so CI runs a reviewed copy rather than whatever is on the internet that day. Then:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to release (leave empty and chamoji picks it from the commits)
        required: false

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - env:
          VERSION: ${{ inputs.version }}
          GH_TOKEN: ${{ github.token }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          set +e
          node scripts/release.mjs --push ${VERSION:+--version "$VERSION"}
          code=$?
          [ "$code" -eq 3 ] && exit 0   # nothing to release
          exit "$code"
```

Adapting it:

- **Release on every push to main:** add `push: { branches: [main] }` under `on:`. Exit code 3 keeps docs-only and test-only pushes from cutting a release, and the bot's own push doesn't retrigger the workflow, because it uses `GITHUB_TOKEN`.
- **Protected main:** the bot can't push to main. Run the script without `--push` on a new branch, open a pull request with `gh pr create`, and push the tag once it merges.
- **Vague commits:** add `--ai`, and set `TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}` under `env:`.
- **Other manifests:** the script bumps `package.json`, `package-lock.json`, `pyproject.toml` and `Cargo.toml`. For anything else, add a step before it that edits the version, and commit it as part of the release.

## Notes workflow

For teams that tag by hand, or whose existing tooling makes the tag, this job writes the GitHub release notes from the commits since the previous tag.

```yaml
name: Release notes

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - env:
          TAG: ${{ github.ref_name }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -e
          previous=$(git tag --list --sort=-v:refname | grep -vx "$TAG" | head -n 1)
          npx --yes @chamoji/cli@latest changelog --to "$TAG" ${previous:+--from "$previous"} \
            | sed '1{/^# Changelog$/d}' > "$RUNNER_TEMP/notes.md"
          gh release create "$TAG" --title "$TAG" --notes-file "$RUNNER_TEMP/notes.md" --verify-tag
```

`grep -vx "$TAG"` picks the newest tag other than this one. That is right when tags are pushed in order. To backfill old tags, compute `previous` from the tag's ancestry instead, for example `git describe --tags --abbrev=0 "$TAG^"`.
