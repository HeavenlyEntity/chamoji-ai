# Terminal Face Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chamoji command that waits shows a living face, and `chamoji` on its own greets you with the animated Marow Block wordmark and a short grouped help screen.

**Architecture:** Following Claude Code, everything is ordinary text in full colour, redrawn on a timer. A foil module colours text with the logo's gradient. A face module draws one-line loading faces on stderr and owns that line while it's up. Core functions report their steps through optional callbacks, and the CLI turns those into faces. The wordmark frames are generated once from the local Marow Block font, and only the resulting strings are committed.

**Tech Stack:** TypeScript (NodeNext), vitest, meow, chalk 6 (new runtime dependency of `@chamoji/cli`). Dev only: `string-width` for the width tests, `@napi-rs/canvas` for the logo generator.

**Spec:** `docs/superpowers/specs/2026-11-03-terminal-face-design.md`

## Global Constraints

- **Faces write only to stderr.** stdout, `--json` output and anything piped stay byte-identical to 0.11.0 for the commands that wait.
- **When nothing animates:** stderr isn't a terminal, `CI` is set, `TERM=dumb`, the command has `--json`, or `CHAMOJI_NO_ANIMATION=1` is set. Output is then exactly today's.
- **Colour follows chalk:** `NO_COLOR` removes colour but faces still animate; `FORCE_COLOR` forces it.
- **Foil stops, in order:** `#d5e1cb` `#afeee5` `#bbbff2` `#a8e2f6` `#dfade5` `#faadc3` `#fbcfb3`. Blends between stops use `(1 − cos(π·f)) / 2`.
- **Light backgrounds get no foil:** wordmark and faces use the default text colour.
- **Theme order:** `CHAMOJI_THEME=light|dark`, then the OSC 11 reply (100 ms limit, only when stdin and stderr are terminals and something will animate), then `COLORFGBG` (background `7` or `15` is light), else dark.
- **Timing:**
  - A face appears only after a step has run 200 ms.
  - The line redraws every 100 ms.
  - The expression changes every 600 to 900 ms.
- **Elapsed format:** `3s`, `1m 4s`, `1h 2m 3s`.
- **One-line faces:**
  - Every frame is 7 columns: rest `( •‿• )`, left `(•‿•  )`, right `(  •‿•)`, blink `( -‿- )`, wink `( •‿- )`, done `( ■‿■ )`, warn `( •_• )`, fail `( ;_; )`.
  - The ASCII set (`CHAMOJI_ASCII=1`, or win32 with no `WT_SESSION`): `( o_o )` `(o_o  )` `(  o_o)` `( -_- )` `( o_- )` `( ^_^ )` `( o_O )` `( ;_; )`.
- **Ending lines:**
  - ok: `( ■‿■ ) ✓ <text> in <elapsed>`
  - warn: `( •_• ) ! <text>`
  - fail: `( ;_; ) ✗ <step label>`
  - Only a step that was drawn leaves an ending line.
- **Wordmark:**
  - It's 68 columns by 8 rows, in quadrant characters only: space and `▗▖▄▝▐▞▟▘▚▌▙▀▜▛█`.
  - Below 70 columns, or with the ASCII set, it becomes the one-line logo `( ■‿■ ) chamoji`.
- **Licensing:** font files never enter git. Only the generated frame strings are committed.
- **Repo style:**
  - prettier @vdemedes, with tabs.
  - NodeNext imports with `.js`.
  - Plain, short sentences in user-facing text.
  - Gitmoji commits with a `Why:` line, stamped `Workstream: terminal-face`.

## Review Focus

1. Ctrl-C while a face is drawn: the line is cleared, the cursor is shown again, and chamoji exits by the same signal. (Task 4)
2. A step writes to stdout or stderr while its face is drawn, as `release` and Jev's `report` do: the text appears whole on its own line and the face redraws below it. (Task 4)
3. A window narrower than the face line: the line is cut to `columns − 1` with `…`, so `\r` and clearing the line never leave wrapped rows behind. (Task 4)
4. The terminal never answers the OSC 11 query, or stdin is piped: no wait beyond 100 ms, stdin's raw mode is restored, and no reply bytes leak into the shell. (Task 1)
5. A command throws out of the middle of a step: the face ends as ✗ with the step's label, and the `chamoji: <message>` line still follows once. (Task 6)

---

## Setup (controller, before Task 1)

- [ ] Work in the existing worktree `.claude/worktrees/terminal-face` on `feat/terminal-face`. Run `pnpm install --frozen-lockfile && pnpm build`.
- [ ] Run `node packages/cli/dist/cli.js hook install`, then `node packages/cli/dist/cli.js ws start "Terminal face" 😎`.
- [ ] Commit `.chamoji/workstreams.yml` with this plan. Check that the commit carries `Workstream: terminal-face`.

### Task 1: Foil colour and theme

**Files:**

- Create: `packages/cli/src/foil.ts`, `packages/cli/test/foil.test.ts`
- Modify: `packages/cli/package.json` (add `chalk` `^6.0.1` to dependencies)

**Interfaces:**

- Produces: `type Rgb = {r: number; g: number; b: number}`, `FOIL_STOPS: readonly Rgb[]`
- Produces: `foilAt(t: number): Rgb`, cyclic over the stops, with `t` in [0, 1) and wrapping
- Produces: `paintFoil(text: string, options: {offset: number; spread: number; level: 0 | 1 | 2 | 3}): string`. Each character with a non-space is coloured by `foilAt(offset + index / spread)` through chalk at that level; level 0 returns `text` unchanged.
- Produces: `type Theme = 'dark' | 'light'`
- Produces: `themeFromEnv(env: Record<string, string | undefined>): Theme | undefined`, which reads `CHAMOJI_THEME`, then `COLORFGBG`
- Produces: `parseOscBackground(reply: string): Rgb | undefined`, which accepts `\x1b]11;rgb:RRRR/GGGG/BBBB` ended by BEL or ST, with 1 to 4 hex digits per channel
- Produces: `isLight(color: Rgb): boolean`, using relative luminance > 0.5
- Produces: `queryBackground(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, timeoutMs = 100): Promise<Rgb | undefined>`
- Produces: `detectTheme(env, query: () => Promise<Rgb | undefined>): Promise<Theme>`, in the theme order from Global Constraints

- [ ] **Step 1: Write the failing tests:**
  - `foilAt hits each stop exactly`: `foilAt(i / 7)` equals stop `i` for 0 to 6
  - `foilAt eases between stops`: the midpoint of stops 0 and 1 equals their channel average, rounded
  - `foilAt wraps`: `foilAt(1.25)` equals `foilAt(0.25)`
  - `paintFoil at level 0 returns the text unchanged`
  - `paintFoil leaves spaces uncoloured`
  - `themeFromEnv`:
    - `CHAMOJI_THEME=light` gives light, and it beats `COLORFGBG=15;0`
    - `COLORFGBG=0;15` gives light, `15;0` gives dark, `default;default` gives undefined
  - `parseOscBackground`:
    - reads `\x1b]11;rgb:ffff/ffff/ffff\x07` as white, and the ST form `\x1b\\` too
    - reads 2-digit channels
    - returns undefined for junk
  - `isLight`: white is light, `#0b0b0f` is dark
  - `detectTheme`:
    - no env and a query resolving undefined gives dark
    - a white reply gives light
    - env beats the query, and the query is never called
  - `queryBackground`:
    - a fake TTY stream that never answers resolves undefined after 100 ms (fake timers) and restores raw mode
    - one that answers resolves the colour and removes its listener

- [ ] **Step 2: Run them and watch them fail.** Run: `pnpm exec vitest run packages/cli/test/foil.test.ts`
- [ ] **Step 3: Implement.** `queryBackground` sets raw mode, writes `\x1b]11;?\x1b\\` to stderr, and collects stdin until BEL or ST or the timeout. It then restores raw mode and pauses stdin, whichever way it ends.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit.**

### Task 2: One-line faces

**Files:**

- Create: `packages/cli/src/faces.ts`, `packages/cli/test/faces.test.ts`
- Modify: `packages/cli/package.json` (add `string-width` to devDependencies)

**Interfaces:**

- Produces: `type FaceName = 'rest' | 'left' | 'right' | 'blink' | 'wink' | 'done' | 'warn' | 'fail'`
- Produces: `FACES: Record<FaceName, string>`, `ASCII_FACES: Record<FaceName, string>`, with the exact strings in Global Constraints
- Produces: `IDLE_LOOP: readonly FaceName[]`: `rest, rest, left, rest, right, rest, blink, rest, wink`
- Produces: `useAscii(env, platform: NodeJS.Platform): boolean`

- [ ] **Step 1: Write the failing tests:**
  - `every face is 7 columns`, measured with `string-width`, in both sets
  - `the idle loop only names faces that exist`
  - `useAscii` is true for `CHAMOJI_ASCII=1`, and for win32 with no `WT_SESSION`. It's false for win32 with `WT_SESSION`, and for darwin.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit.**

### Task 3: The wordmark frames

**Files:**

- Create: `scripts/terminal-logo.mjs`, `packages/cli/src/logo-frames.ts` (generated), `packages/cli/test/logo-frames.test.ts`
- Modify: root `package.json` (add `@napi-rs/canvas` to devDependencies; script `"logo:generate": "node scripts/terminal-logo.mjs"`)

**Interfaces:**

- Produces: `type LogoFace = 'rest' | 'left' | 'right' | 'blink' | 'wink' | 'drop1' | 'drop2' | 'drop3' | 'shades'`
- Produces: `LOGO_FRAMES: Record<LogoFace, readonly string[]>`, `LOGO_WIDTH = 68`, `LOGO_HEIGHT = 8`
- Produces: `O_COLUMNS: readonly [start: number, end: number]`, the columns that hold the O

The prototype's geometry, so the output matches what Alec approved. Units are pixels at 2×2 per cell, drawn at 12× and box-averaged down:

- **Letters:** render `c h a m o j i` in Marow Block. Each letter is cropped to the shared vertical bounds of all seven and scaled to 16 px tall, with a 4 px gap. The O's slot is 6 px wider than its glyph.
- **The O:** it's a rounded rect over the O's box with radius `0.48 × min(w, h)`, filled. A hole inset by `0.13w` and `0.13h` is cut out of it, with radius `0.45 × min` of the hole.
- **The face,** in fractions of the hole (`iw`, `ih`):
  - **Eyes:** circles of radius `0.13·iw`. Rest has them at `(.26, .38)` and `(.64, .22)`; left at `(.20, .36)` and `(.56, .24)`; right at `(.40, .36)` and `(.76, .24)`.
  - **Mouth:** a pie slice centred `(.55, .58)`, radius `0.33·iw`, from −25° to 155°.
  - **Blink:** each eye becomes a bar `±1.2r` wide and `±0.35r` tall.
  - **Wink:** the left eye is the bar and the right eye stays open.
  - **Shades:** lens centres at x `.27` and `.73`, `y = (.30 + drop)·ih`, `lw = .20·iw`, `lh = .22·ih`. The bridge runs from `ax − lw` to `bx + lw`, between `y − .5lh` and `y + .1lh`. The lenses are round rects from `cx ± lw` and `y − .5lh` to `y + lh`, with radius `.6lh`. The drops are −0.45, −0.30 and −0.15; `shades` is 0.
- **Quantising:** a pixel is on above 85% coverage. Each 2×2 cell maps to the quadrant character for its bits, in the order TL, TR, BL, BR, giving `' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█'`.
- **Touch-ups:** any hand fixes are pixel edits listed in the generator, so a rerun reproduces them. At minimum, even out the two eyes in rest, left and right if they come out a pixel apart.

- [ ] **Step 1: Write the generator.** It reads `docs/brand/fonts/MarowBlock-Regular.ttf`. If the font is missing, it exits 1 with `Marow Block isn't in docs/brand/fonts; see docs/brand/fonts/README.md`. It writes `logo-frames.ts` with a header saying it's generated and how to regenerate it.
- [ ] **Step 2: Generate.** Run: `pnpm logo:generate`. Compare `rest` with the prototype frame in the spec; letters must match exactly. Then run the generator again and confirm the file is unchanged.
- [ ] **Step 3: Write the tests,** which run without the font:
  - `every frame is 8 rows of 68 columns`
  - `frames use only quadrant characters and spaces`
  - `frames differ only inside the O`: outside `O_COLUMNS`, every frame equals `rest`
  - `the shades frame has solid lenses`: in row 3, the O columns contain `███ ███`
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm exec vitest run packages/cli/test/logo-frames.test.ts`
- [ ] **Step 5: Commit** the script, the generated file and the package changes. Never commit font files.

### Task 4: The face helper

**Files:**

- Create: `packages/cli/src/face.ts`, `packages/cli/test/face.test.ts`

**Interfaces:**

- Consumes: `paintFoil`, `Theme` (Task 1); `FACES`, `ASCII_FACES`, `IDLE_LOOP` (Task 2)
- Produces: `type StepOutcome = 'ok' | 'warn' | 'fail'`
- Produces: `type Step = {update(label: string): void; end(outcome: StepOutcome, text: string): void}`
- Produces: `type Face = {step(label: string): Step; wrap(write: (text: string) => void): (text: string) => void; stop(): void}`
- Produces: `type FaceOptions`, with these fields:
  - `write: (text: string) => void`, which writes to stderr
  - `level: 0 | 1 | 2 | 3`, `theme: Theme`, `ascii: boolean`
  - `columns: () => number`
  - `clock?: {now(): number; setInterval: typeof setInterval; clearInterval: typeof clearInterval}`
  - `signals?: {once(event: 'SIGINT' | 'SIGTERM', fn: () => void): void; removeListener(event: string, fn: () => void): void; kill(signal: string): void}`
- Produces: `createFace(options: FaceOptions): Face`
- Produces: `NO_FACE: Face`, which draws nothing: `step()` returns no-ops and `wrap` returns `write` itself
- Produces: `formatElapsed(ms: number): string`
- Produces: `runStep<T>(face: Face, label: string, work: (step: Step) => Promise<T>, finish: (result: T) => {outcome: StepOutcome; text: string}): Promise<T>`. A throw ends the step as `fail` with `label` and rethrows.

- [ ] **Step 1: Write the failing tests,** with a fake clock and a recording writer:
  - `formatElapsed`: 3400 gives `3s`, 64000 gives `1m 4s`, 3723000 gives `1h 2m 3s`
  - `a step under 200 ms writes nothing`
  - `a step over 200 ms draws`: the frame starts with `\r\x1b[2K`, hides the cursor once, and shows `( •‿• ) Syncing memory… 0s`
  - `the line redraws every 100 ms and the expression follows IDLE_LOOP` every 700 ms
  - `end ok leaves the done line`: `( ■‿■ ) ✓ Synced memory in 4s` then `\n`, and shows the cursor
  - `end warn` gives `( •_• ) ! …`; `end fail` gives `( ;_; ) ✗ <label>`
  - `update changes the label in place`
  - `wrap clears the face line, writes the text, and redraws the face after it`
  - `a long label is cut to columns − 1 with …`
  - `level 0 writes no colour escapes`; `the light theme writes no colour escapes`
  - `the ASCII set is used when ascii is true`
  - `SIGINT while drawn clears the line, shows the cursor, removes its listener and re-raises SIGINT`
  - `NO_FACE wrap returns the same function`
  - `runStep ends a thrown step as fail with its label and rethrows`
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - Only one step is live at a time. A new `step()` ends any live one as `ok` with its last label.
  - The face and the label are painted with `paintFoil`, with the offset moving by 1/60 per redraw and `spread` 30. Elapsed time is dim. On the light theme, or at level 0, nothing is coloured.
  - Signal handlers are installed only while something is drawn.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit.**

### Task 5: Steps and quiet git in core

**Files:**

- Modify: `packages/core/src/git.ts`, `packages/core/src/memory-sync.ts`, `packages/core/src/release.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/git.test.ts`, `packages/core/test/memory-sync.test.ts`, `packages/core/test/release.test.ts` (extend whichever hold these today)

**Interfaces:**

- Produces: `runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<string>`. `env` is added to `process.env`, as in `runGitWithInput`.
- Produces: `quietGitEnv(cwd: string): Promise<Record<string, string>>`. It returns `{GIT_TERMINAL_PROMPT: '0'}`, plus `GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'` only when `process.env.GIT_SSH_COMMAND` is unset and `git config core.sshCommand` is empty.
- Produces: `isAuthFailure(error: unknown): boolean`. It's true when the message or stderr contains any of: `terminal prompts disabled`, `could not read Username`, `could not read Password`, `Authentication failed`, `Permission denied (publickey`, `Host key verification failed`.
- Produces: `type SyncStep = 'fetch' | 'merge' | 'push'`
- Produces: `pullMemory(cwd, options?: {onStep?: (step: SyncStep) => void; env?: Record<string, string>})` and `syncMemory(cwd, options?)` with the same options. `fetch` fires before the fetch, `merge` before combining, `push` before each push.
- Produces: `ReleaseOptions.onStep?: (step: 'fetch-tags') => void` and `ReleaseOptions.env?`, used by the tag fetches in `planRelease`
- Produces: `pushRelease(plan: ReadyPlan, env?: Record<string, string>): Promise<void>`

- [ ] **Step 1: Write the failing tests:**
  - `runGit passes env through`: run `git var GIT_AUTHOR_IDENT` with `GIT_AUTHOR_NAME=Face`
  - `quietGitEnv adds batch ssh only when nothing sets an ssh command`: test with `core.sshCommand` set in a fixture repo
  - `isAuthFailure` matches each listed phrase in a MemoryError message, and not a `[remote rejected]` error
  - `syncMemory reports fetch, merge, push in order` against the existing fixture remote
  - `syncMemory with no onStep behaves as before`: the existing tests still pass untouched
  - `planRelease reports fetch-tags when origin exists`
- [ ] **Step 2: Run them and watch them fail.** Run: `pnpm exec vitest run packages/core`
- [ ] **Step 3: Implement.** Thread `env` only into the network calls: `fetch` and `push`.
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Commit.**

### Task 6: Faces in the commands

**Files:**

- Create: `packages/cli/src/face-settings.ts`, `packages/cli/test/face-settings.test.ts`
- Modify: `packages/cli/src/cli.ts`, `packages/cli/src/run.ts`, `packages/cli/src/memory.ts`, `packages/cli/src/init.ts`, `packages/cli/src/jev-classifier.ts`, `packages/cli/src/ws.ts`, `packages/cli/src/why.ts`
- Test: `packages/cli/test/run.test.ts`, `memory.test.ts`, `init.test.ts`, `jev-classifier.test.ts`

**Interfaces:**

- Consumes: Tasks 1, 2, 4 and 5
- Produces: `Io.face?: Face`. When it's absent, `NO_FACE` is used, so existing tests are unchanged.
- Produces: `shouldAnimate(input: {env; stderrIsTTY: boolean; argv: string[]}): boolean`, from the "when nothing animates" list in Global Constraints. `--json` anywhere in `argv` counts.
- Produces: `JevClassifierOptions.progress?: (done: number, total: number) => void`. `total` is the number of commits sent to Jev after the cache. It fires after each finished batch.
- Produces: `gitStep<T>(face: Face, cwd: string, label: string, work: (env?: Record<string, string>) => Promise<T>, finish: (result: T) => {outcome: StepOutcome; text: string}): Promise<T>`, in `face.ts`. It runs `work(await quietGitEnv(cwd))` under the face. On `isAuthFailure`, it ends the step as `warn` with `git needs your credentials`, then runs `work(undefined)` with no face.

**Wiring in `cli.ts`:**

- When `shouldAnimate` is true, build `createFace` with these settings:
  - `level` from chalk's `supportsColorStderr`
  - `theme` from `detectTheme(process.env, () => queryBackground(process.stdin, process.stderr))`, queried only when `process.stdin.isTTY`
  - `ascii` from `useAscii`, and `columns` from `process.stderr.columns ?? 80`
- Pass `stdout` and `stderr` through `face.wrap`.

**Steps per command:** labels are the builder's to word, in the style of `Pushing memory to origin`.

| Command                                       | Steps                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory sync`                                 | fetch, merge, push, from `onStep`. Ends ok with the sync summary; `needsForce` ends warn                                                                                                                      |
| `init`                                        | taking in origin's memory around `pullMemory`                                                                                                                                                                 |
| `release`                                     | fetching tags, then Jev's `progress` as `Jev is sorting 25 of 40 commits` when `--ai`. Exit 3 ends ok `Nothing to release`                                                                                    |
| `release --push`                              | pushing HEAD and the tag (`gitStep`), syncing memory (`gitStep`), creating the GitHub release. A sub-step folded into `pushed:` or `memory:` text today ends warn; the summary lines stay exactly as they are |
| `changelog --ai`, `next-version --ai`         | Jev's `progress`                                                                                                                                                                                              |
| `memory search --ai`                          | `Jev is ranking the matches`                                                                                                                                                                                  |
| `why`, `memory reindex`, `ws ship`, `ws drop` | one step each; the 200 ms delay hides it when fast                                                                                                                                                            |

Never a face: `mcp`, `agent-hook`, `hook run`, the composer, `card`, the update check.

- [ ] **Step 1: Write the failing tests,** using a recording fake `Face` that logs `step`, `update` and `end` calls:
  - `shouldAnimate` is false for each item in the list and true for a TTY with a clean env
  - `memory sync reports fetch, merge and push, then ends ok`
  - `memory sync ending in needsForce ends warn`
  - `release --push reports each sub-step in order`, with a fake `gh`
  - `release with nothing to release ends ok Nothing to release, exit 3`
  - `a thrown step ends fail with its label, and stderr has chamoji: <message> once`
  - `gitStep reruns without the quiet env after an auth failure`
  - `jev progress counts only commits sent`: of 40 commits with 10 cached and batch 25, the calls are `(25, 30)` then `(30, 30)`
  - `mcp and agent-hook never call the face`
  - `with no face, stdout and stderr match 0.11.0`: the existing run, memory and release tests pass unchanged
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm build && pnpm test`
- [ ] **Step 5: Commit.**

### Task 7: The welcome screen and help

**Files:**

- Create: `packages/cli/src/welcome.ts`, `packages/cli/test/welcome.test.ts`
- Modify: `packages/cli/src/run.ts` (help text, bare command, unknown command), `packages/cli/test/run.test.ts`

**Interfaces:**

- Consumes: `LOGO_FRAMES`, `O_COLUMNS` (Task 3); `paintFoil`, `Theme` (Task 1); `FACES` (Task 2)
- Produces: `SHORT_HELP: string`, grouped as **Release** (`changelog`, `next-version`, `release`), **Workstreams** (`ws`, `ws start`, `ws switch`, `ws ship`, `ws drop`), **Memory** (`why`, `memory`, `memory search`, `memory sync`), **Commit** (`commit`, `hook install`) and **Setup** (`init`, `init --agents`, `card`, `mcp`). It has one line per command and ends with `Every option: chamoji --help`.
- Produces: `INTRO: readonly {face: LogoFace; ms: number}[]`, played in order: rest 400, left 350, right 350, rest 200, blink 120, rest 200, wink 400, drop1 70, drop2 70, drop3 70, shades 200. That's about 2.4 s.
- Produces: `playWelcome(options: {write; animate: boolean; level; theme: Theme; ascii: boolean; columns: number; sleep?: (ms: number) => Promise<void>}): Promise<void>`
  - **Animated:** draws each intro frame in place, painting the foil diagonally with `spread` 90 and a row weight of 2.2, the offset moving 1/60 per frame. The cursor is hidden while it plays and shown afterwards.
  - **Not animated:** writes the `shades` frame once.
  - **Narrow or ASCII:** below 70 columns, or with the ASCII set, it writes the one-line logo instead.

**Changes in `run.ts`:**

- **Bare `chamoji`:** `playWelcome`, then a blank line and `SHORT_HELP`, all to stdout. Exit 0.
- **`--help`:** the one-line logo, then the full reference, regrouped into the same five groups, with the options and examples kept. It also documents `CHAMOJI_NO_ANIMATION`, `CHAMOJI_THEME` and `CHAMOJI_ASCII`. stdout, exit 0.
- **Unknown command:** `chamoji: unknown command "x"`, then `Run chamoji for the commands, or chamoji --help for every option.` on stderr. Exit 2.
- **The tagline:** draft one that covers changelogs, workstreams and project memory. Flag it in the PR for Alec to approve.

- [ ] **Step 1: Write the failing tests:**
  - `bare chamoji prints the logo and the grouped help to stdout and exits 0`. This replaces `no command prints help and exits 2`.
  - `bare chamoji piped writes no escape codes`
  - `--help lists every command and the three new environment variables`
  - `an unknown command exits 2 with the pointer on stderr`
  - `playWelcome`, with a fake sleep:
    - it writes the frames in INTRO order and ends on shades
    - it moves the cursor up 8 rows between frames, and hides then shows the cursor
  - `playWelcome below 70 columns writes the one-line logo`
  - `playWelcome on the light theme writes no colour escapes`
  - `SHORT_HELP fits in 24 rows below the 8-row logo`
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.** Run: `pnpm check && pnpm test`
- [ ] **Step 5: Commit.**

### Task 8: Real terminals, docs and the record

**Files:**

- Modify: `docs/brand/BRAND.md`, `docs/ROADMAP.md`, `README.md` (the environment variables, wherever options are listed), this plan's Results

- [ ] **Step 1: Check the real thing** in Terminal.app, iTerm2, Ghostty and the VS Code terminal, in a light and a dark profile each:
  - `chamoji` plays the intro, with no foil on the light profiles
  - `chamoji memory sync` against a remote shows the face, its step names and the done line
  - Ctrl-C mid-sync leaves a clean prompt
  - Note which terminals answered OSC 11.
- [ ] **Step 2: Check byte-identity** against 0.11.0, in a scratch clone with memory:
  - `npx @chamoji/cli@0.11.0 memory sync | cat` and the new build `memory sync | cat` print the same
  - the same for `release --dry-run --json`
- [ ] **Step 3: Write the docs:**
  - **`BRAND.md`:** a "Terminal" section covering the wordmark artwork and how to regenerate it, the faces, the foil-on-dark-only rule and the environment variables
  - **`ROADMAP.md`:** list this work
  - **This plan:** record the Results
- [ ] **Step 4: Commit.**

## Results

Built on `feat/terminal-face`, not merged or released.

### What was built

| Task                              | Commits                            | What it did                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                             | `e993667`                          | Started the `terminal-face` workstream and committed `.chamoji/workstreams.yml`                                                                                                                                                              |
| 1. Foil colour and theme          | `b8378ba`, `295edb8`               | `foil.ts`: the seven stops, the cosine blend, `paintFoil`, and the theme order (`CHAMOJI_THEME`, OSC 11, `COLORFGBG`, dark). A late reply is kept from reaching the shell                                                                    |
| 2. One-line faces                 | `5ec8d35`                          | `faces.ts`: the eight 7-column faces, the ASCII set and `useAscii`                                                                                                                                                                           |
| 3. The wordmark frames            | `c422e84`                          | `scripts/terminal-logo.mjs` and `pnpm logo:generate` draw Marow Block into `logo-frames.ts`: 68 by 8 quadrant characters, nine frames. Font not in git                                                                                       |
| 4. The face helper                | `d698bf6`, `32ef007`               | `face.ts`: steps, the 200 ms delay, 100 ms redraw, ending lines and the elapsed format. Partial text survives the first draw                                                                                                                 |
| 5. Steps and quiet git            | `1e74ecd`, `1b5d9f3`               | Sync reports its steps from core, and network git runs quiet. `GIT_SSH` is left alone                                                                                                                                                        |
| 6. Faces in the commands          | `dc1f784`, `288577e`, `34bd087`    | `face-settings.ts`, `gitStep` and Jev's progress; faces in `memory sync`, `init`, `release`, `why`, `memory reindex`, `ws ship`, `ws drop` and the `--ai` runs. A quiet tag fetch retries, a failed Jev is counted and Ctrl-C passes through |
| 7. The welcome screen and help    | `054336a`                          | `welcome.ts`: the animated intro, the short help in five groups, and bare `chamoji` now exits 0 with output on stdout                                                                                                                        |
| 8. Byte-identity, docs and record | the commit that holds this section | The check below, a Terminal section in `BRAND.md`, the roadmap entry and the readme's environment variables                                                                                                                                  |

The design and the plan are in `893c5a8`, `70f2b75`, `1708cb8`, `c3fe36c` and `2695e2e`.

### The final gate

`pnpm build && pnpm exec tsc -p tsconfig.test.json && pnpm exec prettier --check $(git ls-files '*.ts' '*.tsx' '*.mjs' '*.json' '*.md') && pnpm test` passes: **47 test files, 1,209 tests**.

### Byte-identity against 0.11.0

Checked in a scratch setup under the session scratchpad, never against the real chamoji-ai origin:

- A bare repo as `origin`, and a clone `work` with a `v0.1.0` tag, two gitmoji commits on a `scratch-work` workstream (shipped, so it's in memory), a ship commit and one unreleased commit, all pushed.
- A second clone, `work2`, that shipped `other-work` and ran `memory sync`, so `origin` holds memory `work` doesn't, and `work`'s sync has a real merge and push to do.
- Set up with the new build. The whole folder was copied to `bi.base`; before every run it was copied back to the same path, so both versions ran from the same starting state at the same path.

Old is `npx -y @chamoji/cli@0.11.0` (`--version` printed `0.11.0`), new is `node packages/cli/dist/cli.js`. Each ran in `bi/work` with `CHAMOJI_NO_UPDATE_CHECK=1`. Stdout, stderr and the exit code went to separate files, with both streams pipes (as in `| cat`), and the files were compared with `cmp`.

| Command                    | stdout                | stderr              | Exit code     |
| -------------------------- | --------------------- | ------------------- | ------------- |
| `memory sync`              | identical (38 bytes)  | identical (0 bytes) | identical (0) |
| `memory sync --json`       | identical (97 bytes)  | identical (0 bytes) | identical (0) |
| `release --dry-run --json` | identical (429 bytes) | identical (0 bytes) | identical (0) |
| `changelog`                | identical (295 bytes) | identical (0 bytes) | identical (0) |
| `next-version`             | identical (6 bytes)   | identical (0 bytes) | identical (0) |

- **With stderr on a terminal,** where the new build draws its face, stdout still matches. Run under `script`, with stdout redirected to a file and `TERM=xterm-256color`, no `CI`: `memory sync` (38 bytes) and `release --dry-run --json` (429 bytes) are identical. The new build's transcript shows the face, its two step names and the done line, `( ■‿■ ) ✓ Synced memory with origin: 2 entries in 0s`; 0.11.0's shows nothing.
- **The refs left behind** match for `memory sync` and `release --dry-run --json`. For `memory sync --json` the memory commit differs between the two runs only because the merge commit takes its time from the clock, and the runs fell in different seconds.

### Real terminals

Checked in the Claude desktop app's Terminal panel on macOS, on a dark background:

- Bare `chamoji` played the intro and settled on the wordmark with the sunglasses on, then the tagline and the 24-line help. Exit 0.
- `chamoji release --dry-run --any-branch` drew the face on stderr and ended `( ■‿■ ) ✓ Ready to release v0.12.0 in 0s`. Stdout was unchanged.

Not checked yet:

- Terminal.app, iTerm2, Ghostty and the VS Code terminal
- the light profiles
- which terminals answer OSC 11
- Ctrl-C in the middle of a sync

Alec checks these before the release.

### Rulings

See the SDD ledger rulings in the PR description.
