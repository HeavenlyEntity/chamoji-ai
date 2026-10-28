# Milestone 4: Commit Composer and Git Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** writing a good commit becomes the daily habit. `chamoji commit` composes one interactively, and a `prepare-commit-msg` hook offers the same composer on a plain `git commit`. gitmoji-cli users switch with one command.

**Architecture:**

- **Logic in `packages/core/src/compose/`,** pure and tested without a terminal:
  - message formatting
  - fuzzy gitmoji search
  - reading gitmoji-cli's config
  - the hook's "should we prompt?" rules
- **CLI wiring in `packages/cli`:**
  - `commit`, `hook install`, `hook uninstall` and `hook run` (what the installed hook calls)
  - the Ink composer screen, the only part that needs a TTY
  - the composer reads from `/dev/tty` (`CONIN$` on Windows), so it works inside a hook, where stdin isn't the terminal
- **The hook script is one line,** `exec chamoji hook run "$@"`, with npx as a fallback. It's written to `.git/hooks`. With husky or lefthook, which set `core.hooksPath`, the install prints the line to add instead of writing a file.

**Tech stack:** as before, plus `ink` and `react` in the CLI only. `ink-testing-library` for the screen's tests.

**Spec:** `docs/ROADMAP.md`, milestone 4.

## Global constraints

- **Principle 1:** everything works offline, with no API key. No AI in this milestone.
- **The hook never blocks a commit.**
  - If it isn't a terminal, or `CI` is set, or the message already has a gitmoji, or it's an amend, merge, squash or `-m` commit, it exits 0 and changes nothing.
  - Ctrl-C in the composer leaves the original message, and the commit goes ahead.
- **`git commit -m` and editors' commit UIs are untouched.** Both arrive with `source=message` or no TTY.
- **Messages are written as `<gitmoji> [(scope): ]<title>`,** where the gitmoji is the emoji, or `:code:` with `emojiFormat: code`. The body follows. Then the trailers: `BREAKING CHANGE: <text>` when breaking, and `Why: <text>` when the "why?" field is filled.
- **gitmoji-cli config is read from three places,** in this order of precedence: `.gitmojirc.json` in the repo root, the `gitmoji` key in `package.json`, then chamoji's defaults. The keys used are `emojiFormat`, `scopePrompt`, `messagePrompt`, `capitalizeTitle` and `autoAdd`.
- **Commits** use gitmoji and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A hook running under a GUI client** (VS Code, Tower) with no TTY: exit 0, message untouched. Covered in Task 3.
2. **`git commit --amend` and `git rebase`:** never prompt. Covered in Task 3 (`source=commit`, and the rebase-in-progress check).
3. **An existing hook,** either gitmoji-cli's or someone's own script. Install replaces only a hook it recognises (chamoji's or gitmoji-cli's), and otherwise refuses with a message. Covered in Task 4.
4. **A title with a colon or emoji in it,** such as "Fix: Ajax 💥". Formatting must not double the gitmoji or break chamoji's parser. Covered in Task 1, where the formatted message round-trips through `parseCommit`.
5. **Windows:** no `/dev/tty`. Fall back to `CONIN$`, and skip the prompt if neither opens. Covered in Task 5.

---

### Task 1: Message formatting and gitmoji search

**Files:** create `packages/core/src/compose/message.ts` and `packages/core/src/compose/search.ts`. Export both from `index.ts`. Test: `packages/core/test/compose.test.ts`.

**Interfaces:**

- `type CommitDraft = {gitmoji: string; scope?: string; title: string; body?: string; why?: string; breaking?: string | boolean}`, where `gitmoji` is a code without colons
- `formatCommitMessage(draft: CommitDraft, options?: {emojiFormat?: 'emoji' | 'code'; capitalizeTitle?: boolean}): string`
- `searchGitmojis(query: string, limit?: number): GitmojiInfo[]`. Matching order:
  1. the code, exactly
  2. the start of the code
  3. a word of the description
  4. a subsequence of the code

  Ties go to the order of the official list. An empty query gives the official order.

- [ ] **Tests:**
  - a sparkles draft with scope `auth`, title `add login` and `capitalizeTitle` → `✨ (auth): Add login`
  - `emojiFormat: 'code'` → `:sparkles: (auth): Add login`
  - body, `why` and `breaking: 'drops Node 20'` → a body paragraph, then the `BREAKING CHANGE: drops Node 20` and `Why: …` trailers
  - `breaking: true` without text uses the title
  - every formatted message round-trips: `parseCommit` gives back the same gitmoji, scope, description and breaking flag
  - `searchGitmojis('bug')` starts with `bug`
  - `searchGitmojis('fix')` includes `bug`, `ambulance` and `adhesive_bandage`
  - `searchGitmojis('spk')` finds `sparkles`
- [ ] **Commit** `✨ Format commit messages and search gitmojis in core`

### Task 2: gitmoji-cli config

**Files:** create `packages/core/src/compose/config.ts`. Test: `packages/core/test/compose.test.ts`.

**Interfaces:** `type ComposeConfig = {emojiFormat: 'emoji' | 'code'; scopePrompt: boolean; messagePrompt: boolean; capitalizeTitle: boolean; autoAdd: boolean}` and `loadComposeConfig(cwd: string): Promise<ComposeConfig>`.

- [ ] **Tests:**
  - with no files → the defaults (`emoji`, `scopePrompt: true`, `messagePrompt: true`, `capitalizeTitle: true`, `autoAdd: false`)
  - `.gitmojirc.json` `{"emojiFormat": "code"}` → code
  - `package.json` `{"gitmoji": {"scopePrompt": false}}` → applied
  - both files → `.gitmojirc.json` wins
  - a malformed `.gitmojirc.json` → an error naming the file
  - unknown keys are ignored
- [ ] **Commit** `✨ Read gitmoji-cli's config for the composer`

### Task 3: When the hook prompts

**Files:** create `packages/core/src/compose/hook.ts`. Test: `packages/core/test/compose.test.ts`.

**Interfaces:** `shouldPrompt(input: {source?: string; message: string; isTTY: boolean; env: Record<string, string | undefined>; rebasing: boolean}): {prompt: true} | {prompt: false; reason: string}`.

- [ ] **Tests**, one each:
  - `source` is `message`, `merge`, `squash` or `commit` → no prompt, with the reason
  - `rebasing` → no prompt
  - `isTTY: false` → no prompt
  - `CI=1` → no prompt
  - a message whose first line already has a gitmoji, whether ✨ or `:sparkles:` → no prompt
  - a message of only comments and blank lines (`source` undefined or `template`), on a TTY → prompt
- [ ] **Commit** `✨ Decide when the commit hook prompts`

### Task 4: `chamoji hook install` and `uninstall`

**Files:** create `packages/cli/src/hook.ts`, and modify `packages/cli/src/run.ts`. Test: `packages/cli/test/hook.test.ts`.

**Interfaces:** `installHook(cwd): Promise<{written: string} | {snippet: string; hooksPath: string}>` and `uninstallHook(cwd): Promise<boolean>`. The hook file is:

```sh
#!/bin/sh
# chamoji
exec </dev/tty 2>/dev/null; command -v chamoji >/dev/null && exec chamoji hook run "$@" || exec npx --yes @chamoji/cli hook run "$@"
```

- [ ] **Tests** (fixture repos):
  - install writes an executable `.git/hooks/prepare-commit-msg` containing the `# chamoji` marker
  - install again succeeds and doesn't duplicate anything
  - an existing gitmoji-cli hook, which contains `gitmoji --hook`, is replaced. This is the one-command switch.
  - someone else's hook → exit 2, untouched, with a message to remove it or add the line by hand
  - `core.hooksPath=.husky` → nothing written, and the snippet is returned
  - uninstall removes only a chamoji hook
- [ ] **Commit** `✨ Add chamoji hook install and uninstall`

### Task 5: The composer screen, `chamoji commit` and `hook run`

**Files:** create `packages/cli/src/composer.tsx` (Ink) and `packages/cli/src/tty.ts`, and modify `run.ts` and the `package.json` deps. Test: `packages/cli/test/composer.test.tsx` with ink-testing-library.

**Interfaces:** `Composer({config, initial, onSubmit, onCancel})`. The steps, in order:

1. the gitmoji, as a search list
2. the scope, if `scopePrompt`
3. the title
4. the body, if `messagePrompt`
5. why?
6. breaking? (y/N, then a description)

Each step accepts Enter and goes back with Esc. Ctrl-C calls `onCancel`.

- `chamoji commit [-a]` runs the composer, then `git commit -F <tmp>`, with `-a` or with `autoAdd`.
- `chamoji hook run <file> [source] [sha]` reads the file and checks `shouldPrompt`. It opens the TTY with `openTty()` (`/dev/tty`, or `CONIN$` on Windows, or null), runs the composer on it, and writes the message back above the file's `#` comment lines. Cancel and every error exit 0 with the file unchanged.
- [ ] **Tests:**
  - typing `bug` + Enter, `api` + Enter, `fix timeout` + Enter, then skipping the rest → `onSubmit` gets the formatted `🐛 (api): Fix timeout`
  - Esc on the title goes back to the scope
  - Ctrl-C calls `onCancel`
  - `hook run` with `source=message` exits 0 and doesn't change the file
- [ ] **Commit** `✨ Add the commit composer and chamoji commit`

### Task 6: Exit criteria and docs

- [ ] **Shells and hook managers:** a CI job runs `hook run` with a fake TTY under bash, zsh and fish on Linux and macOS, and PowerShell on Windows. It also checks the husky and lefthook snippets with a real `git commit`.
- [ ] **Docs:** a readme section on the composer, the hook and switching from gitmoji-cli, and the roadmap progress.
- [ ] **Commit** `📝 Document the commit composer and hook`
