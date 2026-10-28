# Chamoji brand

The look for every chamoji surface: the editor extension (milestone 10), the desktop app (milestone 12), the Cloud pages (milestones 13–15), the readme and the terminal. It comes from the original chamoji logo (`chamoji-logo.png`, from [HeavenlyEntity/chamoji](https://github.com/HeavenlyEntity/chamoji)).

![Chamoji logo](chamoji-logo.png)

To see the effect rebuilt in CSS, with swatches and UI samples, open [`holo-preview.html`](holo-preview.html) in a browser.

## The chromatic effect

The logo is a **holographic foil plate**:

- **Shape:** a parallelogram slanted **35°**. In CSS that's `transform: skewX(-35deg)`, with the content inside counter-skewed so it stays upright.
- **Surface:** a pastel iridescent sweep from sage and mint through periwinkle and sky to orchid, pink and peach.
- **Rings:** thin-film interference rings (an "oil-slick" pattern) on the left third, fading out toward the centre.
- **Wordmark and mark:** near-black, sitting on top of the foil. The foil is never placed behind light text.

### Colours

Extracted from the logo's pixels, ordered as they appear left to right.

| Token               | Hex       | Role                                          |
| ------------------- | --------- | --------------------------------------------- |
| `--holo-sage`       | `#d5e1cb` | Foil stop                                     |
| `--holo-mint`       | `#afeee5` | Foil stop                                     |
| `--holo-periwinkle` | `#bbbff2` | Foil stop                                     |
| `--holo-sky`        | `#a8e2f6` | Foil stop (the largest area in the logo, 22%) |
| `--holo-orchid`     | `#dfade5` | Foil stop                                     |
| `--holo-pink`       | `#faadc3` | Foil stop                                     |
| `--holo-peach`      | `#fbcfb3` | Foil stop                                     |
| `--ink`             | `#070708` | Wordmark, mark, and any text on foil          |

**Foil gradient:**

```css
--holo: linear-gradient(
	115deg,
	var(--holo-sage),
	var(--holo-mint),
	var(--holo-periwinkle),
	var(--holo-sky),
	var(--holo-orchid),
	var(--holo-pink),
	var(--holo-peach),
	var(--holo-sage)
);
```

Use `background-size: 160% 100%`, and animate `background-position` slowly (about 9 s, alternating) for a sheen. Turn the animation off under `prefers-reduced-motion`. The rings are a `repeating-radial-gradient` of the same stops in roughly 5 px bands, masked to the left. See `holo-preview.html` for the exact CSS.

**Neutral surfaces** carry everything that isn't foil:

| Token         | Light     | Dark      |
| ------------- | --------- | --------- |
| `--surface`   | `#ffffff` | `#0b0b0f` |
| `--surface-2` | `#f4f4f6` | `#16161d` |
| `--text`      | `#070708` | `#f5f5f7` |
| `--muted`     | `#5b5b66` | `#a3a3b2` |

### Rules

- **Foil is an accent, not a background.** Use it for the logo plate, primary buttons, focus rings, active-workstream borders, progress bars and empty-state art. Body text and dense UI sit on neutral surfaces.
- **Text on foil is always `--ink`.** The stops are all light, so ink passes contrast on every one of them. Never put foil-coloured text on white.
- **In dark mode the foil stays as it is.** It reads as light on dark, so keep ink text on it. Borders made of foil, drawn as a masked 1.5 px gradient, work well on dark surfaces.
- **Motion is slow and optional.** The sheen is decoration, so nothing important should depend on it.

## Typography

**Wordmark:**

- **Style:** a wide, monoline geometric sans in uppercase. It has open round bowls, square stroke ends and generous letter spacing.
- **The O:** replaced by a lens mark, a ring with a solid centre and a horizontal bar.
- **Mark:** a tilted smiley, a ring with two dots and an open mouth, cropped by the plate's top-right corner.

**The exact font isn't known yet.** The logo is a flattened PNG, and the old repo has no font files or design source. Closest freely licensed matches to try against it:

| Candidate                                                                    | Notes                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| [Syncopate](https://fonts.google.com/specimen/Syncopate)                     | Wide geometric caps; closest overall shape             |
| [Lexend Zetta](https://fonts.google.com/specimen/Lexend+Zetta) / Lexend Giga | Very wide, monoline; good if Syncopate feels too heavy |
| [Michroma](https://fonts.google.com/specimen/Michroma)                       | Wide and squarer; a fallback                           |

**Open item:** if the original design file exists (Figma, Canva or similar), take the font name from it. Then use that exact face, and keep the wordmark as an SVG traced from the source rather than as live text.

**Interface text:** the wordmark face is for display only (the logo, page titles, empty states). UI and body text use a readable sans, with the system stack as a fallback. Code and terminal output use a monospace face. Settle both in the desktop app's design pass.

## Terminal

The CLI shows the same palette where the terminal supports it:

- **Banner and headings:** a truecolor gradient across the foil stops, with `ink-gradient` / `gradient-string` given the custom stops above. The old chamoji used `ink-gradient`'s `retro` preset, which is a warmer sunset palette and doesn't match the logo.
- **Fallbacks:** 256 colours, then plain text. Colour is turned off for `NO_COLOR`, non-terminal output and `--format json`.

## Assets

| File                | What it is                                                               |
| ------------------- | ------------------------------------------------------------------------ |
| `chamoji-logo.png`  | The original logo, 500 × 233 px, transparent background                  |
| `holo-preview.html` | The foil plate, swatches, button, card and terminal samples in plain CSS |

**Still needed** before milestone 10:

- an SVG of the logo, the wordmark and the mark on its own
- app icons at 16–1024 px
- a favicon
- a social preview image (1280 × 640)
