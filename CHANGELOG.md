# Changelog

## v0.2.0 - 2026-10-28

### Added

- ✨ Add --ai: sort leftover commits with Jev (2ccb6d4)
- ✨ Add an optional classifier hook for commits no rule can sort (312bc9b)
- ✨ Cover more plain-message patterns: Document, bump, \[BREAKING\], init (4256814)
- ✨ Collapse dependency updates into one Dependencies line (d47b4bd)
- ✨ Sort plain commit messages into sections with wording rules (7f6316a)

### Fixed

- 🐛 Keep dev-prefixed package names and count Dependabot group updates (322ceb0)
- 🐛 Tighten wording rules found too broad in review (805b680)

### Security

- 🔒️ Send less to Jev and fail safely (4124a2f)

### Miscellaneous

- 📝 Position review packets against Graphite's current features (fc2087b)
- 📝 Plan review packets and the editor extension (dd84b6f)

## v0.1.0 - 2026-10-27

### Added

- ✨ Add changelog and next-version commands (f537dd0)
- ✨ Render changelog as Markdown, HTML and JSON (6534516)
- ✨ Build releases from git tags and history (9fc678c)
- ✨ Group commits by gitmoji and suggest next version (cceb96b)
- ✨ Parse gitmoji and Conventional Commit messages (b167edb)
- 🎉 Set up pnpm workspace with core and cli packages (1d97d78)
- 🎉 Baseline: Ink prototype before milestone 1 restructure (c95c072)

### Changed

- 📦️ Prepare @chamoji/cli and @chamoji/core for npm (53d4541)
- 🎨 Apply Prettier formatting (3328801)

### Fixed

- 🐛 Fix issues found in branch review (2dd5580)

### Security

- 🔒️ Escape stray backticks in Markdown commit text (e006665)

### Miscellaneous

- 📝 Add generated changelog (5ff690f)
