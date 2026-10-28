# Brand fonts

Two licensed faces:

- **Marow Block** (Regular, v1.000, by Ramandhani): the display face, for the wordmark and large headings.
- **Tansa Bold** (v1.000, by Panca Hasan / Drizy Font): the UI face, for buttons, tabs, labels and headings.

**The font files are not in git.** It's a licensed font, and this repo is public, so committing the `.ttf` or `.otf` would redistribute it. Keep the files here locally; they're git-ignored:

```
docs/brand/fonts/MarowBlock-Regular.ttf
docs/brand/fonts/MarowBlock-Regular.otf
docs/brand/fonts/Tansa-Bold.ttf
docs/brand/fonts/Tansa-Bold.otf
```

**Getting the files:** download both fonts from their licensed sources and copy them here under those names. Maintainers have the original download.

**Shipping it:**

- **Apps:** embed the font in the built app or website, in the desktop bundle or as a self-hosted web font, as the font license allows. Marow Block's embedding flag (OS/2 `fsType` 0) permits it.
- **Marow Block, license confirmed (2026-10-28):** the license covers embedding the font in our app and website. That includes the desktop app bundle, the website and the Cloud pages as a self-hosted web font.
- **Tansa Bold, license confirmed (2026-10-28):** the license covers embedding the font in our app and website, despite its stricter built-in flag (OS/2 `fsType` 4, "preview & print").
- **Never:** publish the raw font files in an npm package or in the repo.

**Marow Block is display only:** it has 111 glyphs, its upper and lower case share one design, and some punctuation is limited. Use it for the logo, titles and empty states, not for body text or UI labels.
