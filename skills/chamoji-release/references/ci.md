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

      - name: Pick the version
        id: pick
        env:
          REQUESTED: ${{ inputs.version }}
        run: |
          if [ -n "$REQUESTED" ]; then
            echo "version=$REQUESTED" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          set +e
          version=$(npx --yes @chamoji/cli@latest next-version)
          code=$?
          set -e
          if [ "$code" -eq 3 ]; then
            echo "Nothing to release since the last tag."
            exit 0
          fi
          [ "$code" -eq 0 ] || exit "$code"
          echo "version=$version" >> "$GITHUB_OUTPUT"

      - name: Changelog, commit, tag, release
        if: steps.pick.outputs.version != ''
        env:
          VERSION: ${{ steps.pick.outputs.version }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -e
          tag="v$VERSION"   # drop the v if the repo's tags have none
          last=$(git tag --list --sort=-v:refname | head -n 1)
          npx --yes @chamoji/cli@latest changelog --release "$tag" --output CHANGELOG.md
          npx --yes @chamoji/cli@latest changelog ${last:+--from "$last"} --release "$tag" \
            | sed '1{/^# Changelog$/d}' > "$RUNNER_TEMP/notes.md"
          npm version "$VERSION" --no-git-tag-version   # or the repo's own version bump
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md package.json package-lock.json 2>/dev/null || git add CHANGELOG.md package.json
          git commit -m "🔖 Release $tag"
          git tag -a "$tag" -m "$tag"
          git push origin HEAD "$tag"
          gh release create "$tag" --title "$tag" --notes-file "$RUNNER_TEMP/notes.md"
```

Adapting it:

- **Release on every push to main:** add `push: { branches: [main] }` under `on:`. Exit code 3 keeps docs-only and test-only pushes from cutting a release. The bot's own release commit doesn't retrigger the workflow, because it is pushed with `GITHUB_TOKEN`.
- **Not a JavaScript package:** replace the `npm version` line with whatever bumps the manifest (`cargo set-version`, a `sed` on `pyproject.toml`), or delete it.
- **Conventional Commits repo:** use `chore(release): 🔖 $tag` as the commit subject.
- **Protected main:** have the job open a pull request instead, for example with `gh pr create`, and tag once it merges.
- **Vague commits:** add `--ai` to both `changelog` calls and set `TYPESAFE_API_KEY` as a repository secret under `env:`.

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
