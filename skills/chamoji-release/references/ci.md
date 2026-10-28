# Changelogs on autopilot (GitHub Actions)

The chamoji GitHub Action does three jobs:

- **Release notes:** on every pushed tag, it writes that tag's notes to its GitHub Release.
- **PR preview:** on every pull request, it keeps one comment up to date with the changelog lines the PR adds and the version merging it would make.
- **Releases:** on request, it cuts the whole release with `chamoji release`.

Pick the workflows that match how the team ships, and commit them under `.github/workflows/`.

These apply to both:

- **Clone the full history:** set `fetch-depth: 0`. A shallow clone has no tags, so the Action stops with a message.
- **Permissions:** release notes and releases need `contents: write`, and the PR comment needs `pull-requests: write`.
- **Pushes made with `GITHUB_TOKEN` don't trigger other workflows.** A separate "publish on tag" workflow won't fire for a tag the release job pushes. Either publish in the same job, or push with a GitHub App or fine-grained token passed as `github-token`.

## Release notes and PR previews

```yaml
name: changelog
on:
  pull_request:
  push:
    tags: ['v*']
permissions:
  contents: write
  pull-requests: write
jobs:
  chamoji:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: HeavenlyEntity/chamoji-ai@v0.5.0
```

On PRs from forks the token can't comment, so the preview goes to the job summary instead.

## Releases on a button press

```yaml
name: release
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
      - uses: HeavenlyEntity/chamoji-ai@v0.5.0
        with:
          mode: release
          release-version: ${{ inputs.version }}
```

It commits `CHANGELOG.md` and the version bumps as `github-actions[bot]`, then pushes the commit and tag and creates the GitHub Release. Exit code 3 (nothing to release) passes, with a note in the job summary.

Adapting it:

- **Release on every push to main:** add `push: { branches: [main] }` under `on:`. Docs-only and test-only pushes don't cut a release. The bot's own push doesn't retrigger the workflow, because it uses `GITHUB_TOKEN`.
- **Protected main:** the bot can't push to main. Cut releases locally with `chamoji release --push` instead, or give the Action a token that may bypass the protection.
- **Vague commits:** add `ai: true` and `typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}`.
