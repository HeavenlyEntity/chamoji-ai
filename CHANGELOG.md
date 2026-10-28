# Changelog

## v0.3.0 - 2026-10-28

### Added

- ✨ Read TYPESAFE_API_KEY from .env.local or .env (65262b6)

### Changed

- 🔨 Add pnpm release script (dfe9fe1)

### Fixed

- 🐛 Make pnpm release atomic, strict about flags, and Windows-safe (2c40d7f)

### Documentation

- 📝 Record milestone 1.6 results and plan the update notice (e5c7454)
- 📝 Add a contributing guide and a default Documentation section (24901e0)
- 📝 Plan milestone 1.6: use chamoji on its own repo (acff618)
- 📝 Make the roadmap our single plan and add the dogfooding track (dd806ab)
- 📝 Add the product roadmap (5dd4b77)

## v0.2.0 - 2026-10-27

### Added

- ✨ Add --ai: sort leftover commits with Jev (2ccb6d4)
- ✨ Add an optional classifier hook for commits no rule can sort (312bc9b)
- ✨ Cover more plain-message patterns: Document, bump, \[BREAKING\], init (4256814)
- ✨ Collapse dependency updates into one Dependencies line (d47b4bd)
- ✨ Sort plain commit messages into sections with wording rules (7f6316a)

### Changed

- 🥅 Explain truncated or non-ASCII TypeSafe API keys (45e49d6)

### Fixed

- 🐛 Keep dev-prefixed package names and count Dependabot group updates (322ceb0)
- 🐛 Tighten wording rules found too broad in review (805b680)

### Security

- 🔒️ Send less to Jev and fail safely (4124a2f)

### Documentation

- 📝 Update changelog for v0.2.0 (3896372)
- 📝 Position review packets against Graphite's current features (fc2087b)
- 📝 Plan review packets and the editor extension (dd84b6f)

### Miscellaneous

- 🙈 Ignore .env files (1a6bbae)

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

### Documentation

- 📝 Add generated changelog (5ff690f)
