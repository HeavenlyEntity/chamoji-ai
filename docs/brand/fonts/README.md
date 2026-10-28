# Brand fonts

**Marow Block** (Regular, v1.000, by Ramandhani) is the chamoji display face, used for the wordmark and large headings.

**The font files are not in git.** It's a licensed font, and this repo is public, so committing the `.ttf` or `.otf` would redistribute it. Keep the files here locally; they're git-ignored:

```
docs/brand/fonts/MarowBlock-Regular.ttf
docs/brand/fonts/MarowBlock-Regular.otf
```

**Getting the files:** download Marow Block from the licensed source and copy it here under those names. Maintainers have the original download.

**Shipping it:**

- **Apps:** embed the font in the built app or website, in the desktop bundle or as a self-hosted web font, as the font license allows. The font's embedding flag (OS/2 `fsType` 0) permits it.
- **License confirmed (2026-10-28):** the Marow Block license covers embedding the font in our app and website. That includes the desktop app bundle, the website and the Cloud pages as a self-hosted web font.
- **Never:** publish the raw font files in an npm package or in the repo.

**Display only:** the font has 111 glyphs, its upper and lower case share one design, and some punctuation is limited. Use it for the logo, titles and empty states, not for body text or UI labels.
