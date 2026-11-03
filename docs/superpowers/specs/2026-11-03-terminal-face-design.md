# Terminal face: the animated logo, help screen and loading faces

**Date:** 2026-11-03
**Status:** design, waiting for approval
**Branch:** `feat/terminal-face`

## Intent

After 0.11.0, `chamoji memory sync` ran with no output until it finished. Nothing said it was working, so it looked stuck. The same is true of every chamoji command that waits on git, GitHub or Jev.

The fix is a living chamoji face in the terminal. A one-line face appears while a command waits; it glances around and blinks, and when the step ends it smiles or frowns. Typing `chamoji` on its own shows the wordmark with the face animating in the O, then a short help screen. Both carry the logo's foil gradient.

The aim is the feel of Claude Code's CLI: small, quick animations that make the tool feel alive and responsive, in chamoji's own look. People should enjoy running chamoji, and should always know it's doing something.

## Goals

- Every command that can wait more than a moment shows a face while it waits, with what it's doing and how long it has taken.
- `chamoji` on its own greets you with the animated wordmark and a help screen short enough to read at a glance.
- It looks like chamoji: the foil gradient, the face from the icon, chamoji's own words.
- Output that a script or CI reads is unchanged.

## Non-goals

- Images, pixel graphics or a separate window. Everything is text characters, as in Claude Code.
- A face for the commit composer. It already has its own screen and never waits on Jev.
- Progress bars with percentages, except where a count is already known (Jev sorting commits in batches).
- Per-command help pages (`chamoji memory --help`). `chamoji --help` keeps printing the full reference.

## Anti-goals

These would make it a failure even if it works:

- **Breaking scripts.** Any escape code, spinner frame or extra line in stdout, in `--json` output, in a pipe or in a CI log.
- **Slowing chamoji down.** A face that delays a fast command, or that flickers onto the screen for a step that finishes in 50 ms.
- **Leaving a mess.** A hidden cursor or a half-drawn line after Ctrl-C or an error.
- **Breaking the brand rules.** Foil-coloured text on a white background (`docs/brand/BRAND.md`), or anything derived from licensed files (the Marow Block font, the purchased emoji pack) in this public repo.
- **Copying Anthropic's writing.** Claude Code's verb list stays theirs.

## How Claude Code does it

Read from the installed Claude Code 2.1.317 binary, for reference:

- Ink (React for the terminal) redraws ordinary text in full colour on a timer. There is no canvas and no image protocol.
- The spinner is six star glyphs, `·` `✢` `✳` `✶` `✻` `✽`, played forward then backward so it pulses. It has fallbacks: `*` in place of `✳` outside macOS, and a repeated `✻` in Ghostty. One helper steps a frame every 250 ms.
- Beside it: a random playful verb with `…`, the elapsed time (`12s`, `1m 4s`) and `esc to interrupt`.
- A shimmer slides colour across the verb, eased with `(1 − cos(2πt / period)) / 2` so it glides.

chamoji takes the method: text frames, a timer, full colour and an eased shimmer. The shapes and the words are chamoji's own.

## Decided in conversation (2026-11-03)

- **Follow Claude Code's practice.** Use text characters in full colour, redrawn on a timer. No images, canvas or GUI window.
- **The wordmark is hand-drawn block letters**, with the face from the icon in the O and the foil gradient across it. The letters echo the logo but aren't traced from Marow Block. The M has two rounded arches, matching the A, so it doesn't read as a W:

  ```
   ▄█████▄  ██    ██   ▄████▄    ▄██▄▄██▄    ▄█████████▄         ██  ██
  ██▀       ██    ██  ██▀  ▀██  ██▀ ██ ▀██  ██     ●   ██        ██  ██
  ██        ████████  ████████  ██  ██  ██  ██  ●      ██        ██  ██
  ██▄       ██    ██  ██    ██  ██  ██  ██  ██  ◥███◤  ██  ██▄  ▄██  ██
   ▀█████▀  ██    ██  ██    ██  ██  ██  ██   ▀█████████▀    ▀████▀   ██
  ```

  It's 69 columns wide. The face inside the O is 9 columns by 3 rows: two eyes at different heights and the wedge grin, as on the icon.

- **Loading screens use a one-line text face** with the same gradient:

  ```
  ( •‿• ) Syncing memory… 2s
  ( ^‿^ ) ✓ Synced memory in 4s
  ( ;_; ) ✗ Couldn't reach origin
  ```

- **chalk does the colour.** It's already installed through Ink 8 (chalk 6); it becomes a direct dependency of `@chamoji/cli`. It handles full colour from hex, falls back to 256 or 16 colours, and honours `NO_COLOR` and `FORCE_COLOR`. The gradient and the animation are a small helper of our own. No other new dependencies.

## The three pieces

### 1. Foil colour

- **Stops:** the seven foil stops from `BRAND.md`, in order: `#d5e1cb` `#afeee5` `#bbbff2` `#a8e2f6` `#dfade5` `#faadc3` `#fbcfb3`.
- **Blending:** each character gets its own colour, blended between neighbouring stops by its position along the gradient, then coloured with chalk.
- **The wordmark gradient runs diagonally,** like the stripes on the icon: the position is the column plus a multiple of the row.
- **The shimmer:** the gradient slides one step per frame, with the cosine ease so it glides.
- **Light backgrounds** (my call, see below): no foil colour.

### 2. The loading face

- **The line:** the face, then the step, then the elapsed time, all written to stderr, for example `( •‿• ) Pushing memory to origin… 3s`. Time uses Claude Code's format: `3s`, `1m 4s`, `1h 2m 3s`.
- **The face loop:** look ahead, glance left, glance right, blink, perk up. Every frame is exactly 7 columns, so the text beside it never moves:

  ```
  ( •‿• )   (•‿•  )   (  •‿•)   ( -‿- )   ( ◕‿◕ )
  ```

- **Speed:** the colour redraws about every 100 ms. The expression changes more slowly, every 600 to 900 ms, so the face looks calm, not frantic.
- **On success:** the line becomes `( ^‿^ ) ✓ <what happened> in <time>`.
- **On failure:** the line becomes `( ;_; ) ✗ <the step that failed>`, for example `✗ Pushing memory to origin`. It names the step, not the error. The command's own `chamoji: <message>` line follows unchanged, so nothing is said twice.
- **A warning:** a step that ends badly without throwing ends on `( •_• ) ! <what happened>`. Examples: a `release --push` sub-step that is caught and folded into the `pushed:` or `memory:` text today, or `syncMemory` returning `needsForce`. The command's summary lines are unchanged.
- **Nothing to do:** exit code 3 from `next-version` or `release` ends on `( •‿• ) ✓ Nothing to release`.
- **How outcomes are reported:** each step ends with an outcome of `ok`, `warn` or `fail`, set by the CLI from the result or the exception. It doesn't learn about failures only from exceptions.
- **The delay:** the face appears only after a step has run for 200 ms, so fast steps never flash it. A step that ends before then prints nothing extra.
- **Several steps:** a command with several steps (`release --push`) keeps one line and changes its text per step. Each finished step stays on screen as a ✓ line.

### 3. The wordmark and help screen

**Typing `chamoji` with no command:**

1. The wordmark draws with the foil shimmering. The face in the O glances, blinks, then grins: about 1.2 s in all.
2. It settles on the grin, still in colour.
3. The short help prints below it.
4. The prompt comes back.

The help is grouped and fits on one screen:

- **Release:** `changelog`, `next-version`, `release`
- **Workstreams:** `ws`, `ws start`, `ws switch`, `ws ship`, `ws drop`
- **Memory:** `why`, `memory`, `memory search`, `memory sync`
- **Commit:** `commit`, `hook install`
- **Setup:** `init`, `init --agents`, `card`, `mcp`

Each command gets one short line. A closing line points to `chamoji --help` for every option.

The tagline changes from "Changelogs from gitmoji and Conventional Commits" to one that covers workstreams and project memory. The builder drafts it, and Alec approves it.

**Other cases:**

- **`chamoji --help`:** the full reference as today, regrouped the same way, with a small one-line logo header: the gradient `chamoji` and the face. stdout, exit 0.
- **An unknown command:** `chamoji: unknown command "x"`, then a pointer to `chamoji` and `chamoji --help`, on stderr. Exit 2.
- **The help changes everywhere,** piped or not: the regrouping, the new tagline, and bare `chamoji` on stdout with exit 0. The byte-identical rule below covers the commands that wait, not the help. When nothing animates, the logo header and the wordmark print as plain text with no escape codes. The existing test "no command prints help and exits 2" is rewritten to match.

## Where the face appears

| Command                                       | Steps it shows                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `memory sync`                                 | fetching origin's memory; merging; pushing memory                                     |
| `init`                                        | taking in origin's memory                                                             |
| `release` (and `--dry-run`)                   | fetching tags; Jev sorting commits (with `--ai`)                                      |
| `release --push`                              | the above, then pushing HEAD and the tag; syncing memory; creating the GitHub release |
| `changelog --ai`, `next-version --ai`         | Jev sorting commits, with a count from the batches: `25 of 40`                        |
| `memory search --ai`                          | Jev ranking the matches                                                               |
| `why`, `memory reindex`, `ws ship`, `ws drop` | local work, usually fast; the 200 ms delay means the face only shows in big repos     |

`memory sync` and the `release --push` steps run inside single core calls today (`syncMemory`, the push flow). To show their steps, those core functions take an optional step callback. My call; the builder may choose another way to report steps.

**The Jev count** is the number of commits actually sent to Jev, after the rules and the judgment cache have placed the rest. It moves once per finished batch, so it jumps in batch-sized steps (`25 of 40`, then `40 of 40`), and that's fine. `createJevClassifier` gains an optional progress callback for this.

**Other output during a step.** The face owns the line it draws. Anything else written to stderr while it runs goes through the face helper. Jev's failure and summary lines, the update notice and `Wrote <file>` are all examples. The helper clears the face line, writes the text, then redraws the face below it.

**git asking for a password.** `git fetch` and `git push` can prompt through the terminal: an https username, or an ssh passphrase. A face redrawing every 100 ms would wipe out that prompt. So network git steps run with the face non-interactively first:

- `GIT_TERMINAL_PROMPT=0` turns off https prompts.
- ssh runs in batch mode, but only when the user hasn't set their own ssh command (`GIT_SSH_COMMAND` or `core.sshCommand`).

If git fails for lack of credentials, the face stops and says git needs your credentials. The step then reruns normally, with no face, so the prompt works. Nothing was fetched or pushed by the failed attempt, so the rerun is safe. The builder decides how to recognise an authentication failure from git's output.

**Never a face:**

- **`mcp` and `agent-hook`:** their stdout is a protocol.
- **The update check:** it runs in the background.
- **The commit composer:** it has its own screen.
- **`card`:** it computes locally and makes no network call.

## When nothing animates

The face and the wordmark animation turn off, and output stays exactly as it is today, when:

- stderr isn't a terminal: a pipe, a file, CI capture
- `CI` is set, or `TERM=dumb`
- the command has `--json`
- `CHAMOJI_NO_ANIMATION=1` is set (a new switch, for people who want stillness)

Colour follows chalk: `NO_COLOR` removes colour but the face still animates, as in Claude Code. `FORCE_COLOR` forces colour.

When bare `chamoji` has nothing to animate, it prints the wordmark once, plain or coloured as above, then the help.

## Calls I made (check these)

1. **Light terminals get no foil.** `BRAND.md` forbids foil-coloured text on white, and the pastels are unreadable there. When the terminal reports a light background (`COLORFGBG` ending in `;7` or `;15`), or `CHAMOJI_THEME=light` is set, the wordmark and faces use the default text colour, which on a light terminal is near ink. Terminals that report nothing are treated as dark, since most developer terminals are. `CHAMOJI_THEME=dark` forces dark.
2. **The intro plays once, about 1.2 s, then the prompt comes back.** It doesn't stay alive until a keypress.
3. **Bare `chamoji` exits 0 and writes to stdout,** where today it writes to stderr and exits 2. An unknown command still exits 2.
4. **Narrow terminals.** Below 72 columns, the wordmark is replaced by the one-line face and a gradient `chamoji`.
5. **Wide or ambiguous characters.** `●`, `•`, `◥`, `◤` and box-drawing characters are single width in Western terminals but can be double width in East Asian locales. An ASCII face set is the fallback, used when `CHAMOJI_ASCII=1` is set or on the legacy Windows console (win32 with no `WT_SESSION`):

   ```
   ( o_o )   ( ^_^ )   ( ;_; )
   ```

6. **Steps from core.** Core functions report steps through an optional callback; the CLI owns the face.
7. **The words are factual first.** Each step says what it's doing in chamoji's voice ("Pushing memory to origin…", "Jev is sorting 12 of 40 commits…"), not a random verb. The face carries the fun; the words carry the facts.
8. **Ctrl-C** restores the cursor and clears the face line before exiting with the usual signal code.

## Left to the builder

- The module layout and names in `packages/cli/src`.
- How the face helper reaches commands. It goes through the `io` object like the other terminal pieces, so tests can pass a fake that records steps instead of drawing.
- Exact frame timings within the ranges above.
- The exact one-line descriptions in the short help, and the step wording, in the plain, short style of the existing help text.
- Whether the bare-`chamoji` intro uses Ink or the same helper as the loading face.

## Tests

- Every face frame, small and large, has the same display width. A test measures it.
- Gradient blending returns the exact stop colours at the stops and blends between them.
- With a fake clock and a fake writer: no output before 200 ms; frames after; a ✓ or ✗ line at the end; the cursor shown again after a thrown error.
- With stderr not a terminal, `--json`, `CI` or `TERM=dumb`, the bytes written are identical to today's output.
- Bare `chamoji` prints the grouped help to stdout and exits 0. An unknown command exits 2 on stderr.
- `memory sync` and `release --push` report their steps in order through the fake.

## Done when

- `chamoji memory sync` in a real terminal shows the face within 200 ms of a slow fetch, the step names change as it goes, and it ends on a ✓ line.
- `chamoji` alone plays the intro and prints the short help on a dark terminal, and shows no foil on a light one.
- `chamoji memory sync | cat` and `chamoji release --dry-run --json` are byte-identical to 0.11.0.
- `BRAND.md` gets a "Terminal" section covering the wordmark, the faces and the light-background rule.
- The roadmap lists this work.
