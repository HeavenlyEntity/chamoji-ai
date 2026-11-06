# Sponsors page design

Date: 2026-11-05
Status: draft, waiting on the owner's approval
Where it gets built: the private `chamoji-web` repo (`apps/site`, `apps/docs`, `packages/brand`), plus a README section in this repo.
Design reference: the "Sponsors page (chamoji.dev/sponsors)" board on the chamoji design canvas, https://claude.ai/artifact/PZE5BypQRLgUjNH61ERMxc (private to the owner). Its source is the file `project/Sponsors.dc.html` in that canvas, readable with the Artifact tool's read action. It holds all the copy, the layout at desktop and phone widths, and working ports of every background effect with their tuned settings (in the board's script). So the effects are a port of known settings, not new work. To render it locally, follow the "Rendering the design canvas locally" note in the owner's project memory. A builder who can't read the canvas should get a copy of that file from the owner before starting.

## Why

The chamoji CLI is free and MIT licensed. The page asks companies to pay to keep it that way, and in return puts their logo where developers already are: the docs they read while setting chamoji up, the README on GitHub and npm, and later the terminal itself.

The model is React Bits' sponsors page (https://reactbits.dev/sponsors). The owner asked for the same shape: a spot on the page for each sponsor, a badge per tier, sections that explain why to sponsor, and the line "Reach developers while they build." It's true for chamoji for the same reason it's true for React Bits: people learn the tool in its docs.

## Goals

- A page at `chamoji.dev/sponsors` that makes a company want to sponsor and lets it pay in a couple of clicks.
- A badge for each tier and a visible spot for each sponsor, so a company can see exactly what it's buying before it pays.
- Sponsor logos shown in the three places the page promises: the sponsors page, the docs sidebar and the README.
- One list of sponsors that all three places read from.

## Non-goals

- The CLI sponsor line (the Holo perk). The page sells it as "Coming later," and it gets its own design once its behavior is decided (see Open questions).
- A sponsor dashboard, self-serve logo upload or any account system. Sponsors are added by hand.
- Prices other than USD.

## Anti-goals (it fails if these happen, even if it works)

- The page looks like a generic pricing template. It must look like chamoji: holo foil, ink outlines, Phosphor duotone icons.
- The animations make the page slow or hard to read. Labels stay readable over every background, and anyone who asks for reduced motion sees a still page.
- Sponsors end up somewhere developers resent: inside CI logs, or as ads that slow developers down.
- Numbers on the page that aren't true.

## Decided by the owner

- **Tiers and prices**, the same as React Bits, plus a fourth tier priced by Claude and accepted by the owner:
  - Silver $100/month
  - Platinum $250/month
  - Diamond $500/month
  - Holo $1,000/month
- **Tier perks**, as shown on the canvas:
  - **Silver:** "For indie makers and small teams." Logo in the README; logo in the docs sidebar; listed on the sponsors page.
  - **Platinum:** "More room, more reach." Larger logo in the README and docs sidebar; a shoutout on X and in the release post; listed on the sponsors page.
  - **Diamond:** "The biggest spot on the web." Marked "Most visible." The largest logo in the docs sidebar and README; a shoutout on X and in the release post; featured on the sponsors page; a direct line for feedback and requests.
  - **Holo:** "The only spot inside the terminal." Marked "Coming later." Everything in Diamond; the sponsor's name in the CLI after each release; the first spot on the sponsors page; one Holo sponsor at a time.
- **Payments go through Creem, in a separate chamoji store** (not the AMWare store). All four products already exist there, live: monthly USD subscriptions with tax included, tax category "digital goods/service," and the success URL `https://chamoji.dev/sponsors?thanks=1`. They were created on 2026-11-05.

  | Tier     | Creem product ID              |
  | -------- | ----------------------------- |
  | Silver   | `prod_1lPVRZiyUoR7UHiw6XWa98` |
  | Platinum | `prod_4hvJcmwemkNj3e6ZOnyKY6` |
  | Diamond  | `prod_5kaFFZdKTJuOO9jjDqi8zR` |
  | Holo     | `prod_4FeN4fp5UayqGZ9IRl165Q` |

  Holo is active in Creem, so anyone with its link can buy it, but the page doesn't link to its checkout yet (see Checkout).

- **React Bits backgrounds**, animated behind each sponsor spot to make it more inviting:
  - Holo: Light Rays
  - Diamond: Iridescence
  - Platinum: Aurora
  - Silver: Squares
  - The "In the CLI" placement card: Faulty Terminal, with the sponsor's name shimmering in foil colors
- **Stats on the page:** 2,480 npm downloads of the CLI last month; 28 docs pages; 8K monthly visitors to chamoji.dev. GitHub stars are left off.

## The page, top to bottom

The canvas board is the source of truth for layout, copy and styling. The builder matches it, and the summary below is only for orientation.

1. **Nav.** The site's existing nav, with a new "Sponsors" link marked as the current page and a "Become a sponsor" button that scrolls to the tiers.
2. **Hero.** A hand-heart icon tile on a soft foil glow. Kicker "Sponsors." Heading "Keep chamoji free." Sub-heading "The chamoji CLI is free and MIT licensed. These teams help keep it that way, and their logos sit beside every page of the docs." Two buttons: "Become a sponsor" (to `#tiers`) and "Email us."
3. **Sponsor wall.** At the top, a full-width Holo spot (described in "The Holo spot" below). Under it, one Diamond spot (220px tall), two Platinum spots (150px) and four Silver spots (110px), each with its tier badge. An empty spot says "Your logo here" and "Sponsor as <tier>" on a frosted plate, and links to `#tiers`. A filled spot shows the sponsor's logo and links to the sponsor's site. Each spot has its tier's React Bits background.
4. **Reach (`#reach`).** Kicker "Why sponsor." Heading "Reach developers while they build." Then the three stats, then three placement cards, each with a small mockup:
   - "Every docs page," showing the docs sidebar
   - "The README"
   - "In the CLI," with a Holo badge and the Faulty Terminal mockup of `chamoji release --push` ending in "Supported by Your Company yourcompany.dev"
5. **Tiers (`#tiers`).** Heading "Pick a badge." Sub-heading "Monthly plans. Cancel anytime. Every tier comes with its badge on the sponsors page." Four tier cards with prices and perks. Diamond is featured with a foil border. Holo has a dashed border and "Coming later," and its button reads "Ask about Holo."
6. **Custom packages (`#email`).** A card that says "Need a different package?" with an email button.
7. **Closing band.** The foil band "Put your logo where developers ship."
8. **Footer.** The site's existing footer, with a Sponsors link added.

## The Holo spot

The owner asked for the Holo spot to be the first thing on the wall, designed to build anticipation so a company wants to claim it. It sits above Diamond, at the full width of the wall.

- **The card.**
  - About 320px tall.
  - Ink #070708 in both light and dark themes, so it reads as the terminal.
  - A thin foil border that slowly turns (a conic foil gradient, one turn every 8 seconds).
  - On hover it lifts and glows lavender.
- **The background.** React Bits **Light Rays**, shining down from above the right half of the card onto the empty logo frame, like a spotlight on an empty stage. The rays shade from aqua to lavender to pink across the width.
- **Left side, the pitch.**
  - The Holo badge and a pill that reads "1 of 1 · Opening soon."
  - Heading "Your logo, inside every release."
  - Body "One company gets the only spot inside the chamoji CLI, plus this one at the top of the page."
  - A foil "Ask about Holo" button and the note "Reserved for one company."
- **Right side, the preview.**
  - **The logo frame:** an empty frame that says "Your logo here" and "First on this page." Its dashed border pulses slowly between aqua and pink, with a soft glow.
  - **A mini terminal:** `$ chamoji release --push`, `done tagged v0.15.0 and pushed`, then "Supported by" followed by "Your Company" in shimmering foil. The name types itself out letter by letter, holds, erases and types again, with a blinking cursor. This shows the CLI perk instead of just describing it.
- **Where it links.** The whole card links to the sponsor email while Holo is "Coming later" (see Checkout).
- **When Holo is claimed.** The frame shows the sponsor's logo and the terminal shows their real name and site, still shimmering. The pill changes to "1 of 1 · Claimed." _Claude's call._
- **Reduced motion** (and, on the canvas only, its motion switch). These stop the border, the rays, the pulse, the typing and the cursor. The name then shows in full.
- **Phone width.** The two sides stack, pitch first.

**Tier badges** (also used in the docs sidebar):

| Tier     | Icon         | Badge background           |
| -------- | ------------ | -------------------------- |
| Silver   | medal        | #ececf1                    |
| Platinum | crown-simple | #bbbff2                    |
| Diamond  | diamond      | the foil gradient          |
| Holo     | sparkle      | #070708, with #afeee5 text |

Icons are Phosphor duotone from Iconify, drawn the brand way: ink #070708 outlines, with the duotone layer filled with the holo foil gradient.

**Thanks state.** When the page loads with `?thanks=1` (where Creem sends sponsors after paying), it shows a short banner above the wall. The banner thanks them and says what happens next: we already have their company name and site from checkout, they should email their logo (light and dark versions if they have them), and their spot goes up once it arrives. The banner has a "Send your logo" button, a `mailto:info@amware.dev` link with the subject filled in ("chamoji sponsor logo"). Creem's success redirect doesn't tell the page which tier they bought, so the banner doesn't name one.

**Contact address.** Every email button on the page uses `info@amware.dev`, the owner's choice, and the same address the site's pricing section already uses: "Email us," "Ask about Holo," "Need a different package?," the Holo card and "Send your logo."

**Light and dark.** The page follows the site's existing theme.

## Checkout

- The Silver, Platinum and Diamond buttons link to each product's Creem payment link, `https://www.creem.io/payment/<id>`, the form Creem's docs use. On 2026-11-05, both `/payment/<id>` and `/product/<id>` redirected straight to a live Creem checkout page (`/checkout/<id>/<session>`), with no storefront step in between. _Claude's call:_ no server code and no API key on the site. A server-side checkout session is only worth adding if we later need to pass metadata through checkout.
- The Holo button stays "Ask about Holo" and opens the sponsor email, not checkout, until the CLI line is built. _Claude's call_, following the page's "Coming later."
- The product IDs live in one place in `packages/brand` (next to `site.ts`), not scattered through components.
- **Sponsor details come from checkout (the owner's choice).** All four Creem products get two required text fields at checkout:
  - "Company name, as it should appear"
  - "Company website"

  The logo still comes by email, because Creem's custom fields take text only. The products were created without these fields, so adding them is a build step. It's a change to live products, so the owner makes it or approves it: in the Creem dashboard, or through the API if product updates accept custom fields. The CLI's `products update` has no custom-field flag.

## One sponsor list

- A typed list in `packages/brand`, for example `sponsors.ts`. _Claude's call._ Each entry holds:
  - name
  - site URL
  - tier
  - logo files, light and dark
  - start date
- Adding a sponsor means adding an entry and its logo files, then deploying. When the list is empty, every spot is the "Your logo here" placeholder.
- The sponsors page wall, the docs sidebar block and the README section are all built from this one list.
- _Claude's call:_ the wall always shows the 1 / 2 / 4 grid. Sponsors fill spots in their tier, and leftover spots stay as placeholders. A tier with more sponsors than spots grows its row.

## Docs sidebar

- A "Sponsors" block at the bottom of the docs navigation (`apps/docs/src/components/Navigation.tsx`), above the mobile install button.
- Logos are sized by tier: Diamond largest, then Platinum, then Silver. With no sponsors, the block shows one small "Become a sponsor" link to `chamoji.dev/sponsors`.
- It must not push the docs links down on short screens. _Claude's call:_ the block sits after the last nav group and never sticks.

## README

- A "Sponsors" section in this repo's `README.md`, between marker comments so it can be regenerated. Logos are sized by tier and link to the sponsors' sites. It ends with a "Become a sponsor" link.
- Logo images are served from `chamoji.dev`, so the public repo never holds them.
- _Claude's call:_ a small script in `chamoji-web` prints the README block from the sponsor list, and someone pastes it in by hand. No cross-repo automation for now.

## Animated backgrounds

- Use the real React Bits components, the same way the site already uses React Bits pieces (`apps/site/components/magic-bento.tsx`, `star-border.tsx`): copy each component into `apps/site/components/` and adapt it to the site's CSS. The site doesn't use Tailwind.
- The WebGL backgrounds (Light Rays, Iridescence, Aurora, Faulty Terminal) need `ogl`. Squares is a plain 2D canvas.
- Tint the effects to the foil palette, as on the canvas:
  - **Light Rays:** aqua to lavender to pink by angle, over ink.
  - **Iridescence:** pastel, washed toward white in light mode and darker in dark mode.
  - **Aurora:** the stops aqua #afeee5, lavender #bbbff2 and pink #faadc3. The second Platinum spot runs them in reverse.
  - **Squares:** a faint grid drifting toward the corner, with some cells fading in and out in foil colors.
  - **Faulty Terminal:** tinted aqua to lavender to pink across the width, and dim behind the command text.
- Performance rules:
  - Load the effects only on the sponsors page, on the client.
  - Pause each one when it's off screen or the tab is hidden.
  - Cap the device pixel ratio at 1.5.
  - Use the site's `use-reduced-motion` hook: with reduced motion, draw one still frame.
- Readability: labels sit on a frosted plate (`color-mix` of the card color at about 84% plus a backdrop blur) and must pass 4.5:1 contrast over any frame.
- License: React Bits is MIT plus Commons Clause. Using its components inside our site is allowed. Selling the components themselves is not, and we don't.

## Site wiring

- Add a Sponsors link to the site nav, the site footer and the docs' `SITE_LINKS`.
- _Claude's call:_ the nav keeps "Join the waitlist" as its only button on every page, `/sponsors` included, because it's the site's main sign-up. The canvas's "Become a sponsor" nav button doesn't ship, since the hero's own "Become a sponsor" button does that job. The Sponsors link shows as current on `/sponsors` through a small client piece that reads the pathname. The rest of the nav stays a server component.
- _Claude's call:_ the site gets no visible motion switch. That switch exists only on the canvas for reviewing. On the site, motion follows `prefers-reduced-motion` through the existing `use-reduced-motion` hook.
- Add `/sponsors` to `sitemap.ts` and to `llms.txt`.
- Give the page its own title, description and Open Graph image, in the same style as the home page.
- Count page views the way the other pages do: the Whop page-view hook, which tracks only.
- The stats stay hand-set constants in `packages/brand`, each with the date it was measured. The page doesn't show the dates. The current values:
  - 2,480 npm downloads, for October 2026, read on 2026-11-05
  - 28 docs pages, counted on 2026-11-05
  - 8K monthly visitors, given by the owner on 2026-11-05 They get refreshed with the other landing-page numbers after each release.

## Testing

- Unit tests for the sponsor list:
  - Each tier maps to the right spots and sizes.
  - Leftover spots become placeholders.
  - An overfull tier grows its row.
  - The README block prints correctly.
- A check that each tier's checkout link uses that tier's product ID.
- The page builds and type-checks, and renders correctly in light, dark and reduced motion, at desktop and phone widths.

## Open questions (the owner's call)

None of these block this build: Holo stays "Coming later," and a rename is a text change.

1. **The CLI sponsor line (Holo).** How often it shows, whether it never shows in CI, and whether users can turn it off. This decides whether Holo can open, and needs its own design.
2. **The name "Holo."** Is it the right name for the top tier?
3. **The release-post shoutout and one Holo sponsor at a time.** Are they the right promises?

## Left to the builder

- Component structure, file names and CSS organization, within the site's existing patterns.
- How the copied React Bits components are adapted to the site's CSS and to the reduced-motion hook.
- The exact layout of the docs sidebar block, within the rules above.
- The Open Graph image design, in the home page's style.
