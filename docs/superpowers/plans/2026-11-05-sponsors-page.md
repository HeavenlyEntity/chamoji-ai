# Sponsors Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `chamoji.dev/sponsors`, with Creem checkout for each tier. Sponsor logos appear on that page, in the docs sidebar and in the README, all built from one list.

**Architecture:** A typed sponsor module in `packages/brand` holds:

- the tiers, prices and Creem product IDs
- the sponsor list
- the email address
- the stats
- the pure functions that lay out the wall and print the README block

The site renders the page from it, using React Bits backgrounds ported to the site's plain CSS. The docs sidebar and the README read the same module.

**Tech Stack:** Next.js 16 (App Router; read `apps/site/node_modules/next/dist/docs/` before writing page code, per `apps/site/AGENTS.md`), React 19, TypeScript, plain CSS (the site doesn't use Tailwind), `ogl` for the WebGL backgrounds, Vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-05-sponsors-page-design.md` (in chamoji-ai). The design source is `project/Sponsors.dc.html` in the canvas https://claude.ai/artifact/PZE5BypQRLgUjNH61ERMxc. All copy, layout values, icon paths and effect settings come from that file.

**Repos:** Tasks 1–9 run in `chamoji-web` (private), on a branch `feat/sponsors-page` from `main`. Task 10 runs in `chamoji-ai` (public). Commit messages use gitmoji, as both repos do.

## Global Constraints

- Prices, all monthly USD: Silver $100, Platinum $250, Diamond $500, Holo $1,000.
- Creem product IDs:
  - Silver `prod_1lPVRZiyUoR7UHiw6XWa98`
  - Platinum `prod_4hvJcmwemkNj3e6ZOnyKY6`
  - Diamond `prod_5kaFFZdKTJuOO9jjDqi8zR`
  - Holo `prod_4FeN4fp5UayqGZ9IRl165Q`
- Checkout link: `https://www.creem.io/payment/<id>`. Holo has no checkout link on the page; its button opens email.
- Every email button uses `info@amware.dev`. The "Send your logo" link has the subject "chamoji sponsor logo".
- Wall spots per tier: Holo 1, Diamond 1, Platinum 2, Silver 4. Heights: Diamond 220px, Platinum 150px, Silver 110px, Holo about 320px.
- Backgrounds:
  - Holo: Light Rays
  - Diamond: Iridescence
  - Platinum: Aurora (stops #afeee5, #bbbff2, #faadc3; the second spot runs them reversed)
  - Silver: Squares
  - The "In the CLI" card: Faulty Terminal
- Foil palette: #d5e1cb, #afeee5, #bbbff2, #a8e2f6, #dfade5, #faadc3, #fbcfb3. Ink: #070708.
- Motion follows `prefers-reduced-motion` through `usePrefersReducedMotion` (`@chamoji-web/brand/use-reduced-motion`). The site has no motion switch. With reduced motion, each effect draws one still frame, and the Holo name shows in full.
- Effects: load on the client, on `/sponsors` only; pause when off screen or when the tab is hidden; cap the device pixel ratio at 1.5.
- Labels over effects sit on a frosted plate and pass 4.5:1 contrast.
- Logo files live in `apps/site/public/sponsors/` and are served from `https://www.chamoji.dev/sponsors/<file>`. They never go in chamoji-ai.
- The licensed fonts (Tansa, Know, Marow Block) are already in `apps/site/app/fonts`. Use the CSS variables `--font-ui`, `--font-know` and `--font-marow`.
- The nav keeps "Join the waitlist" as its only button on every page.

## Review Focus

1. **A sponsor entry with bad data:** a missing logo, a non-https URL, or a logo path with `..` or `/` in it. The build should fail with a message naming the sponsor, rather than shipping a broken image or a `javascript:` link. (Task 1: `validateSponsors`.)
2. **Two Holo sponsors in the list.** "One at a time" is a promise, so laying out the wall should throw instead of quietly showing both. (Task 1.)
3. **WebGL unavailable**, from an old device or a browser out of contexts. The spot should show its plain card and readable plate, not a black or blank box, and log no error. (Task 3 returns nothing when `getContext` is `null`; Task 11 checks it in the browser.)
4. **A long sponsor name or a very wide logo in a 110px Silver spot at 375px width.** It should stay inside the spot (logo `object-fit: contain`, name clamped to two lines), with no horizontal page scroll. (Task 5, verification step, using a fixture sponsor.)
5. **`/sponsors` opened with other query strings,** like `?thanks=0`, `?thanks=yes` or `?thanks=1&x=2`. The banner should show only when `thanks` is exactly `1`, and the page should otherwise look unchanged. (Task 6: `isThanks`.)

---

### Task 1: The sponsor module

**Files:**

- Create: `packages/brand/src/sponsors.ts`
- Create: `packages/brand/src/sponsors.test.ts`
- Modify: `packages/brand/package.json` (add `"./sponsors": "./src/sponsors.ts"` to `exports`)

**Interfaces:**

- Produces:
  - `type SponsorTier = 'holo' | 'diamond' | 'platinum' | 'silver'`
  - `const TIER_ORDER: readonly SponsorTier[]`, in the order `['holo','diamond','platinum','silver']`
  - `const TIERS: Record<SponsorTier, {name: string; priceUsd: number; productId: string; spots: number}>`
  - `type Sponsor = {name: string; url: string; tier: SponsorTier; logo: {light: string; dark?: string}; since: string /* YYYY-MM-DD */}`
  - `const SPONSORS: Sponsor[]`, empty at launch
  - `function checkoutUrl(tier: SponsorTier): string | null`
  - `const SPONSOR_EMAIL = 'info@amware.dev'`
  - `function mailto(subject?: string): string`
  - `function logoUrl(file: string): string`, which returns `${SITE_ORIGIN}/sponsors/${file}`
  - `function validateSponsors(list: Sponsor[]): void`, which throws an `Error` whose message contains the sponsor's name
  - `type WallRow = {tier: SponsorTier; spots: Array<Sponsor | null>}`
  - `function wallRows(list: Sponsor[]): WallRow[]`
  - `const SPONSOR_STATS: Array<{key: 'downloads' | 'pages' | 'visitors'; value: string; label: string; measuredOn: string}>`

- [ ] **Step 1: Write the failing tests** in `sponsors.test.ts`:
  - `test('tiers carry the spec prices, spots and Creem IDs')`: asserts `TIERS.silver` equals `{name:'Silver', priceUsd:100, productId:'prod_1lPVRZiyUoR7UHiw6XWa98', spots:4}`, plus the same for Platinum (250, `prod_4hvJcmwemkNj3e6ZOnyKY6`, 2), Diamond (500, `prod_5kaFFZdKTJuOO9jjDqi8zR`, 1) and Holo (1000, `prod_4FeN4fp5UayqGZ9IRl165Q`, 1).
  - `test('checkout links use each tier’s product, and Holo has none')`: `checkoutUrl('diamond')` is `'https://www.creem.io/payment/prod_5kaFFZdKTJuOO9jjDqi8zR'`, and likewise for Silver and Platinum. `checkoutUrl('holo')` is `null`.
  - `test('mailto goes to info@amware.dev with an encoded subject')`: `mailto()` is `'mailto:info@amware.dev'`, and `mailto('chamoji sponsor logo')` is `'mailto:info@amware.dev?subject=chamoji%20sponsor%20logo'`.
  - `test('an empty list gives a full wall of placeholders')`: `wallRows([])` maps to `[['holo',1],['diamond',1],['platinum',2],['silver',4]]` (tier and spot count), with every spot `null`.
  - `test('sponsors fill their tier in start order, and leftovers stay placeholders')`: two Silver sponsors with `since` values `'2026-12-01'` and `'2026-11-20'` give a Silver row of `[the 11-20 one, the 12-01 one, null, null]`.
  - `test('a tier with more sponsors than spots grows its row')`: three Platinum sponsors give a Platinum row of length 3 with no `null`.
  - `test('two Holo sponsors throw')`: `expect(() => wallRows([holoA, holoB])).toThrow(/one Holo sponsor/i)`.
  - `test('validateSponsors names the sponsor it rejects')`: it throws with the sponsor's name for:
    - a `url` that doesn't start with `https://`
    - an empty `logo.light`
    - a logo file containing `/` or `..`
    - a `since` that isn't `YYYY-MM-DD`

    It passes for a valid entry.

  - `test('stats carry the spec values and dates')`: `SPONSOR_STATS` holds:

    | key       | value     | label                                   | measuredOn     |
    | --------- | --------- | --------------------------------------- | -------------- |
    | downloads | `'2,480'` | `'npm downloads of the CLI last month'` | `'2026-11-05'` |
    | pages     | `'28'`    | `'Docs pages that show your logo'`      | `'2026-11-05'` |
    | visitors  | `'8K'`    | `'Monthly visitors to chamoji.dev'`     | `'2026-11-05'` |

- [ ] **Step 2: Run the tests and see them fail.** Run `pnpm --filter @chamoji-web/brand test`. Expected: FAIL, "Cannot find module './sponsors'".
- [ ] **Step 3: Implement `sponsors.ts`.**
  - `wallRows` calls `validateSponsors` first.
  - It then groups by tier in `TIER_ORDER`, sorts each group by `since` ascending (ties by name), and pads with `null` up to `TIERS[tier].spots`.
  - It throws `Error('There can only be one Holo sponsor at a time')` when there's more than one Holo sponsor.
  - Import `SITE_ORIGIN` from `./site`.
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/brand test && pnpm --filter @chamoji-web/brand check`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit.** `git add packages/brand && git commit -m "✨ Add the sponsor tiers, list and wall layout"`

### Task 2: The brand icons and tier badge

**Files:**

- Modify: `packages/brand/src/icons.ts` (add `medal`, `crown-simple`, `diamond`, `hand-heart`, `envelope-simple`, `download-simple`, `files` and `users-three`)
- Create: `apps/site/components/sponsors/tier-badge.tsx`
- Create: `apps/site/components/sponsors/tier-badge.test.tsx`

**Interfaces:**

- Consumes: `SponsorTier` and `TIERS` (Task 1); `ICONS` and `IconName` (`@chamoji-web/brand/icons`).
- Produces:
  - `function TierBadge(props: {tier: SponsorTier; small?: boolean}): JSX.Element`
  - `function Icon(props: {name: IconName; size?: number}): JSX.Element`, the duotone icon: the first path gets `className="ico-fill"` (foil), the second is ink. Reuse the markup the existing `pricing.tsx` icons use. If a shared icon component already exists, use it.

- [ ] **Step 1: Write the failing test.** `test('each tier badge shows its icon and color')` renders with `renderToStaticMarkup`:
  - `TierBadge tier="silver"`: contains `Silver` and `background:#ececf1`, and renders the `medal` paths.
  - Platinum: `#bbbff2` and `crown-simple`.
  - Diamond: the foil gradient (`linear-gradient(115deg`) and `diamond`.
  - Holo: `#070708` with text color `#afeee5`, and `sparkle`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @chamoji-web/site test -- tier-badge`. Expected: FAIL, module not found.
- [ ] **Step 3: Add the icons and the badge.** Take each new icon's two paths from the canvas board's inline SVGs. They're Iconify `ph:<name>-duotone`, so the opacity-0.2 path comes first. The badge is a pill: icon, then the tier name, in `--font-ui` 700, at 13px (12px when `small`).
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/site test -- tier-badge && pnpm --filter @chamoji-web/brand check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "✨ Add the sponsor tier badges and their icons"` (add the new files first).

### Task 3: The React Bits backgrounds

**Files:**

- Modify: `apps/site/package.json` (add `ogl`, pinned to the exact version React Bits' install of these components asks for)
- Create, in `apps/site/components/sponsors/backgrounds/`:
  - `use-effect-loop.ts`
  - `use-effect-loop.test.ts`
  - `light-rays.tsx`
  - `iridescence.tsx`
  - `aurora.tsx`
  - `squares.tsx`
  - `faulty-terminal.tsx`
  - `index.ts`

**Interfaces:**

- Consumes: `usePrefersReducedMotion`.
- Produces:
  - `function shouldAnimate(s: {inView: boolean; hidden: boolean; reduced: boolean}): boolean`, a pure function.
  - `function useEffectLoop(ref: RefObject<HTMLElement | null>, draw: (t: number) => void): void`. It runs `requestAnimationFrame` while `shouldAnimate` is true (via `IntersectionObserver`, `document.visibilityState` and the reduced-motion hook), and with reduced motion calls `draw` once with a fixed `t`.
  - `const SponsorBackground = { LightRays, Iridescence, Aurora, Squares, FaultyTerminal }`, exported from `index.ts` through `next/dynamic` with `{ssr: false}`. Each component takes `{className?: string; reversed?: boolean}` (`reversed` applies to Aurora only), renders one absolutely positioned `<canvas aria-hidden="true">`, and fills its parent.

- [ ] **Step 1: Write the failing test.** `test('animates only in view, in a visible tab, without reduced motion')` checks:
  - `shouldAnimate({inView:true, hidden:false, reduced:false})` is `true`.
  - Each of `inView:false`, `hidden:true` and `reduced:true` on its own gives `false`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @chamoji-web/site test -- use-effect-loop`. Expected: FAIL.
- [ ] **Step 3: Implement the hook, then port the five components.**
  - Start from each React Bits component's source (reactbits.dev, the TypeScript CSS variant), the way `magic-bento.tsx` and `star-border.tsx` were ported. Put a header comment in each file naming the source and what changed.
  - Replace each component's own animation loop with `useEffectLoop`.
  - Cap the device pixel ratio at 1.5.
  - Call `WEBGL_lose_context` on unmount.
  - Set the colors and settings the canvas board's script uses (`_shader` and `_squares`): the tints, speeds, and the Squares cell size of 26px with blinking foil cells.
  - When `getContext` returns `null`, render nothing and log nothing.
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/site test && pnpm --filter @chamoji-web/site check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "✨ Port the React Bits backgrounds for the sponsor spots"` (The WebGL fallback is checked in the browser in Task 11, once the page exists.)

### Task 4: The Holo spot

**Files:**

- Create: `apps/site/components/sponsors/holo-spot.tsx`
- Create: `apps/site/app/sponsors/sponsors.css` (this task starts the file; later tasks add to it)

**Interfaces:**

- Consumes: `TierBadge` (Task 2); `SponsorBackground.LightRays` (Task 3); `Sponsor`, `mailto` and `logoUrl` (Task 1).
- Produces: `function HoloSpot(props: {sponsor: Sponsor | null}): JSX.Element`

- [ ] **Step 1: Write the failing test** `holo-spot.test.tsx`:
  - `test('an open Holo spot sells the CLI line and links to email')`: with `sponsor={null}`, the markup contains:
    - `1 of 1 · Opening soon`
    - `Your logo, inside every release.`
    - `Ask about Holo`
    - `Reserved for one company`
    - `Your logo here`
    - `First on this page`
    - `Supported by`
    - `Your Company`
    - `href="mailto:info@amware.dev"`
  - `test('a claimed Holo spot shows the sponsor')`: with a fixture sponsor, the markup contains `1 of 1 · Claimed`, the sponsor's name in the terminal line, an `<img` whose `alt` is the sponsor's name and whose `src` is `logoUrl(sponsor.logo.light)`, and a link to the sponsor's URL with `rel="sponsored noopener"`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @chamoji-web/site test -- holo-spot`. Expected: FAIL.
- [ ] **Step 3: Build it to the canvas board's `.holo-ring` and `.holo-spot` markup and CSS.**
  - The turning conic foil border, at 8 seconds per turn.
  - The ink card, at least 320px tall with 40px padding.
  - Light Rays behind it.
  - The logo frame, with its border pulsing between aqua and pink over 3.2s.
  - The mini terminal, typing "Your Company" in 12 steps on a 7s loop, with a 1s caret blink.
  - The two sides stack below about 760px, pitch first.
  - Under `@media (prefers-reduced-motion: reduce)`, the CSS animations stop and the name shows at full width.
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/site test -- holo-spot`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "✨ Add the Holo spot to the sponsor wall"`

### Task 5: The sponsor wall

**Files:**

- Create: `apps/site/components/sponsors/sponsor-wall.tsx`
- Create: `apps/site/components/sponsors/sponsor-wall.test.tsx`
- Modify: `apps/site/app/sponsors/sponsors.css`

**Interfaces:**

- Consumes: `wallRows` and `TIERS` (Task 1); `TierBadge` (Task 2); `SponsorBackground` (Task 3); `HoloSpot` (Task 4).
- Produces: `function SponsorWall(props: {sponsors: Sponsor[]}): JSX.Element`

- [ ] **Step 1: Write the failing tests:**
  - `test('an empty wall shows the Holo spot and seven placeholders')`: the markup has one `holo-spot` and seven `class="slot` elements. Each `slot` links to `#tiers` and contains `Sponsor as <Tier>`. The Diamond spot says `Your logo here`, and the Silver spots say `Your logo`.
  - `test('a filled spot links to the sponsor and keeps placeholders around it')`: one Platinum fixture sponsor gives one `<a` to its URL with `rel="sponsored noopener"`, and leaves one Platinum placeholder.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @chamoji-web/site test -- sponsor-wall`. Expected: FAIL.
- [ ] **Step 3: Implement the wall.**
  - Rows come from `wallRows(sponsors)`: Holo, then Diamond (one column), Platinum (two columns), then Silver (four columns, two below 760px).
  - Each placeholder has its background (Iridescence, Aurora, `reversed` on the second Platinum spot, or Squares), its tier badge in the top left, and the label on the frosted plate (`.slot-plate`, as on the canvas).
  - A filled spot shows the logo on the plate:
    - `<picture>` with a dark `<source media="(prefers-color-scheme: dark)">` when `logo.dark` is set
    - `object-fit: contain`, with a max height of 60% of the spot
    - `alt` set to the sponsor's name
  - Placeholder copy and the CSS (`.slot`, `.slot-bg`, `.slot-plate`, the dashed edge in `--slot-edge`) come from the board.
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/site test -- sponsor-wall`. Expected: PASS.
- [ ] **Step 5: Check overflow (Review Focus 4).** Temporarily pass a fixture Silver sponsor with a 40-character name and a 10:1 logo, and view `/sponsors` at 375px wide. Expected: the logo and name stay inside the spot, and there's no horizontal scroll. Remove the fixture afterward.
- [ ] **Step 6: Commit.** `git commit -m "✨ Add the sponsor wall"`

### Task 6: The page, its sections and its SEO

**Files:**

- Create: `apps/site/app/sponsors/page.tsx`
- Create: `apps/site/app/sponsors/opengraph-image.tsx`
- Create, in `apps/site/components/sponsors/`:
  - `sponsors-hero.tsx`
  - `reach.tsx` (the stats and the three placement cards, the CLI card with Faulty Terminal)
  - `tier-cards.tsx`
  - `tier-cards.test.tsx`
  - `thanks-banner.tsx`
  - `thanks.ts`
  - `thanks.test.ts`
- Modify:
  - `apps/site/lib/seo/pages.ts` (add `PAGES.sponsors`)
  - `apps/site/lib/seo/seo.test.ts`
  - `apps/site/app/sponsors/sponsors.css`

**Interfaces:**

- Consumes: everything above; `SPONSOR_STATS`, `checkoutUrl` and `mailto` (Task 1); `pageMetadata`, `JsonLd` and `webPage` (`@/lib/seo`).
- Produces:
  - `function isThanks(value: string | string[] | null | undefined): boolean`
  - `PAGES.sponsors`, with:
    - `path:'/sponsors'`
    - `name:'Sponsors'`
    - `changeFrequency:'monthly'`
    - `priority:0.6`
    - a title of at most 70 characters, for example `'Sponsor chamoji: put your logo where developers ship'`
    - a description of at most 160 characters, naming the docs, the README and the tiers

- [ ] **Step 1: Write the failing tests:**
  - `test('the thanks banner shows only for thanks=1')`: `isThanks('1')` is `true`. `isThanks('0')`, `isThanks('yes')`, `isThanks(['1','1'])`, `isThanks(null)` and `isThanks(undefined)` are all `false`.
  - In `seo.test.ts`: `test('the sponsors page has its own canonical URL')`: `pageMetadata(PAGES.sponsors).alternates` equals `{canonical:'/sponsors'}`, and `llmsTxt()` contains `/sponsors`.
  - In `tier-cards.test.tsx`: `test('paid tiers check out on Creem and Holo asks by email')`: the Silver, Platinum and Diamond cards link to their `checkoutUrl`, and the Holo card's button says `Ask about Holo` and links to `mailto:info@amware.dev`.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @chamoji-web/site test`. Expected: FAIL on the new tests.
- [ ] **Step 3: Build the page.** In order:
  1. Hero
  2. `<Suspense><ThanksBanner /></Suspense>`
  3. `<SponsorWall sponsors={SPONSORS} />`
  4. Reach (`#reach`)
  5. Tier cards (`#tiers`)
  6. The `#email` card
  7. The closing foil band (reuse `components/foil-band.tsx`, if it takes the copy)

  Details:
  - Copy is exactly as on the board, apart from the stat values, which come from `SPONSOR_STATS`.
  - `ThanksBanner` is a client component. It reads `useSearchParams().get('thanks')` through `isThanks`, and its "Send your logo" link is `mailto('chamoji sponsor logo')`.
  - The page exports `metadata = pageMetadata(PAGES.sponsors)` and renders `<JsonLd data={webPage(PAGES.sponsors)} />`, as `app/compare/page.tsx` does.
  - The Open Graph image follows the root `app/opengraph-image.tsx` style, with the hand-heart tile and "Keep chamoji free."

- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/site test && pnpm --filter @chamoji-web/site check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "✨ Add the sponsors page"`

### Task 7: The nav, footer and docs links

**Files:**

- Create: `apps/site/components/nav-link.tsx`
- Modify:
  - `apps/site/components/site-nav.tsx` (add Sponsors after Docs)
  - `apps/site/components/site-footer.tsx` (add Sponsors next to Compare)
  - `apps/docs/src/lib/site-links.ts`
  - `apps/docs/src/lib/links.test.ts`

**Interfaces:**

- Produces: `function NavLink(props: {href: string; children: ReactNode; className?: string}): JSX.Element`, a client component. It reads `usePathname()` and sets `aria-current="page"` and the `on` class when the path matches `href`.

- [ ] **Step 1: Write the failing test.** In `links.test.ts`: `test('the docs link to the sponsors page')`: `SITE_LINKS` contains `{title:'Sponsors', href:'https://www.chamoji.dev/sponsors'}`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @chamoji-web/docs test -- links`. Expected: FAIL.
- [ ] **Step 3: Add the links.** In the site nav, use `<NavLink href="/sponsors">Sponsors</NavLink>`. The rest of `SiteNav` stays a server component, and "Join the waitlist" is unchanged. Add `.nav-link.on` to `landing.css` if it isn't there (on the canvas, the current link is underlined in foil).
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm test && pnpm check` at the repo root. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "🔗 Link the sponsors page from the nav, footer and docs"`

### Task 8: The docs sidebar block

**Files:**

- Create: `apps/docs/src/components/SponsorsBlock.tsx`
- Create: `apps/docs/src/components/SponsorsBlock.test.tsx`
- Modify: `apps/docs/src/components/Navigation.tsx` (render the block after the last `NavigationGroup`, before the mobile install `<li>`)

**Interfaces:**

- Consumes: `wallRows`, `logoUrl` and `Sponsor` (`@chamoji-web/brand/sponsors`); `SITE_ORIGIN`.
- Produces: `function SponsorsBlock(props: {sponsors: Sponsor[]}): JSX.Element`

- [ ] **Step 1: Write the failing tests:**
  - `test('with no sponsors it invites one')`: it renders a single link to `https://www.chamoji.dev/sponsors` with the text `Become a sponsor`, and no `<img`.
  - `test('logos are sized by tier and link out')`: for one Diamond and one Silver fixture, the Diamond `<img` has a larger height class than the Silver one, both `alt` values are the sponsors' names, and both links have `rel="sponsored noopener"`.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @chamoji-web/docs test -- SponsorsBlock`. Expected: FAIL.
- [ ] **Step 3: Implement the block.** It has a small "Sponsors" heading in the nav-group style. Sponsors come from `wallRows(...)`, skipping `null` spots, Holo first. Logo heights: Holo and Diamond 40px, Platinum 28px, Silver 20px. Use plain `<a>` and `<img>` with absolute `logoUrl`s. The block never sticks.
- [ ] **Step 4: Run the tests and see them pass.** Run `pnpm --filter @chamoji-web/docs test && pnpm --filter @chamoji-web/docs check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "✨ Show sponsors in the docs sidebar"`

### Task 9: The README block script

**Files:**

- Create: `packages/brand/src/sponsors-readme.ts`
- Create: `packages/brand/src/sponsors-readme.test.ts`
- Create: `packages/brand/scripts/print-readme-sponsors.ts`
- Modify: `packages/brand/package.json` (add the script `"readme:sponsors": "node --experimental-strip-types scripts/print-readme-sponsors.ts"`)

**Interfaces:**

- Consumes: `wallRows` and `logoUrl` (Task 1).
- Produces:
  - `const README_START = '<!-- sponsors:start -->'`
  - `const README_END = '<!-- sponsors:end -->'`
  - `function readmeSponsorsBlock(list: Sponsor[]): string`, which returns the text from `README_START` through `README_END`

- [ ] **Step 1: Write the failing tests:**
  - `test('an empty list prints only the invitation')`: `readmeSponsorsBlock([])` is exactly:

    ```
    <!-- sponsors:start -->
    [Become a sponsor](https://www.chamoji.dev/sponsors)
    <!-- sponsors:end -->
    ```

  - `test('logos print as linked images sized by tier')`: for one Diamond fixture, the block contains `<a href="<url>"><img src="https://www.chamoji.dev/sponsors/<file>" alt="<name>" height="60"></a>`. The heights are Holo and Diamond 60, Platinum 44, Silver 32. The invitation line still ends the block.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @chamoji-web/brand test -- sponsors-readme`. Expected: FAIL.
- [ ] **Step 3: Implement the function and the script.** The script prints `readmeSponsorsBlock(SPONSORS)` to stdout.
- [ ] **Step 4: Run the tests and the script.** Run `pnpm --filter @chamoji-web/brand test && pnpm --filter @chamoji-web/brand readme:sponsors`. Expected: PASS, and the script prints the three-line empty block.
- [ ] **Step 5: Commit.** `git commit -m "📝 Print the README sponsors block from the sponsor list"`

### Task 10: The README section (in chamoji-ai)

**Files:**

- Modify: `README.md` in chamoji-ai: add `## Sponsors` before `## License`

- [ ] **Step 1: Add the section.** Under the heading, put one line, "chamoji is free and MIT licensed. These teams help keep it that way.", then paste the output of `pnpm --filter @chamoji-web/brand readme:sponsors` from Task 9.
- [ ] **Step 2: Verify.** Run `pnpm check` in chamoji-ai (prettier and the build). Expected: PASS. The README shows the section with the "Become a sponsor" link.
- [ ] **Step 3: Commit, on its own branch from `main` in chamoji-ai.** `git commit -m "📝 Add a Sponsors section to the README"`

### Task 11: The owner's Creem step, and a full check

- [ ] **Step 1: Owner (manual; live Creem changes are blocked for agents).** In the chamoji store's Creem dashboard, add two required text fields at checkout to each of the four sponsor products:
  - "Company name, as it should appear"
  - "Company website"
- [ ] **Step 2: Build everything.** Run `pnpm test && pnpm check && pnpm build` at the chamoji-web root. Expected: everything passes, and `/sponsors` shows in the build output.
- [ ] **Step 3: Check the page in the browser.** Start the site's dev server and check `/sponsors` against the canvas board at 1440px and 375px wide, in light and dark, and with reduced motion. Expected:
  - the layout and copy match the board
  - every effect pauses when scrolled out of view
  - reduced motion shows still frames and the Holo name in full
  - the console shows no errors
  - `?thanks=1` shows the banner
  - the three checkout buttons open Creem checkout
- [ ] **Step 4: Check the WebGL fallback (Review Focus 3).** In the browser, run `HTMLCanvasElement.prototype.getContext = () => null` before the page loads (or start Chrome with `--disable-webgl`), then load `/sponsors`. Expected: every spot shows its card and plate, the console shows no errors, and no black boxes appear.
- [ ] **Step 5: Check the docs.** With the docs dev server, the sidebar shows "Become a sponsor" at the bottom without pushing links off short screens (an 800px-tall window).
- [ ] **Step 6: Open a pull request in chamoji-web** for `feat/sponsors-page`, and one in chamoji-ai for the README branch.
