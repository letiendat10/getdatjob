---
name: getdatjob-branding
description: >
  Brand reference for getdatjob — use this skill whenever working on any
  visual surface: UI components, landing page edits, marketing copy, email
  design, or anything that needs to look on-brand. Always consult this before
  writing any CSS, Tailwind classes, or copy that will appear on screen. Triggers
  on phrases like "match the brand", "match the style", "brand colors", "what
  font", "component style", "design tokens", "match the landing page", "make it
  consistent with our brand/style", "keep it on-brand". This is a reference doc,
  not a code generator — read it, then apply the knowledge to the task at hand.
---

# getdatjob Brand Reference

Source of truth for colors, typography, and component patterns.
Pull from `web/src/app/globals.css` and `web/src/app/landing.module.css`.

---

## Color tokens

Defined as CSS custom properties in `globals.css`. Always use the token name, not a raw hex, unless you're writing vanilla CSS that can't reference variables.

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#F4F0E8` | Main page background (warm cream) |
| `--bg-2` | `#EBE6DA` | Secondary background, hover fills, secondary buttons |
| `--ink` | `#171614` | Primary text, dark buttons, footer background |
| `--ink-2` | `#3A3833` | Secondary text |
| `--ink-3` | `#6F6A60` | Muted / tertiary text |
| `--line` | `#D9D2C2` | Borders and dividers |
| `--accent` | `#1F3A2E` | Benefit section tags, small label text — **not** for headline italic emphasis |
| `--card` | `#FAF7F0` | Card backgrounds (slightly lighter than `--bg`) |
| `--gold` | `#C9A24A` | Decorative only — laurel leaves, star icons |
| `--night` | `#0E1116` | Reserved — dark mode |
| `--night-2` | `#171B22` | Reserved — dark mode |

**Key rules:**
- Backgrounds are cream, never white
- `--accent` is a very dark color — do not substitute with a bright green or any blue
- `--accent` is **never** used for the wordmark, nav links, or any header text — those are always `var(--ink)` (black)
- `--gold` is decorative only, never interactive
- The apply button on `/jobs` uses Tailwind `bg-zinc-900` (`#18181b`) — this is page-scoped, not a global brand token

---

## Typography

Three font families loaded in `layout.tsx` and exposed as CSS variables via `@theme inline`.

| Variable | Font | Use |
|---|---|---|
| `--font-geist-sans` | Geist | Body text, buttons, nav, all UI chrome |
| `--font-instrument-serif` | Instrument Serif (400) | Headlines, hero title, section titles, testimonial quotes |
| `--font-geist-mono` | Geist Mono | Labels, badges, small tags (benefit tags, filters) |

**Size ramp** (from `landing.module.css`):

| Role | Size | Font |
|---|---|---|
| Hero title | `clamp(38px, 4.6vw, 58px)` | Instrument Serif |
| Section titles | `clamp(34px, 4.4vw, 56px)` | Instrument Serif |
| Body | `15.5–16.5px` | Geist Sans |
| Badges / labels | `11–13px`, `letter-spacing: .06–.14em`, uppercase | Geist Mono |

**Recurring pattern:** italic emphasis on a key phrase inside a headline, using `font-style: italic` with `color: var(--ink)` (near-black). Do **not** color italic headline phrases with `var(--accent)` — that is for small benefit tags and labels only.

**All headline lines are `var(--ink)`** — including secondary/continuation lines. Never use `var(--ink-3)` on any part of a headline. `--ink-3` is for body-level muted text only (sub-labels, captions, helper text).

---

## Components

### Top announcement strip
- Full-width bar above the nav
- `background: var(--ink)` · `color: #E9E5DA` · `font-size: 13px` · `height: 40px`
- Centered text with `gap: 14px` between elements

### Nav / header
- Sticky, `z-index: 30`
- Frosted glass: `background: rgba(244,240,232,.85); backdrop-filter: saturate(140%) blur(10px)`
- `border-bottom: 1px solid rgba(0,0,0,.04)` · height `62px`
- **Wordmark:** "getdatjob" plain text · Geist Sans · weight 600 · `letter-spacing: -.015em` · `font-size: 17px` · `color: var(--ink)` — **always black, never `var(--accent)` or any green**
- **Nav CTA:** `background: var(--ink)` · `color: #F4F0E8` · `padding: 9px 16px` · `border-radius: 999px` · weight 500 · `font-size: 14px`

### Cards (visa cards / job cards)
- `background: var(--card)` · `border: 1px solid var(--line)` · `border-radius: 18–20px` · `padding: 26px 24px`
- **Icon tile:** `46×46px` · `border-radius: 14px` · `background: var(--ink)` · icon in `#F4F0E8`
- **Card heading:** Instrument Serif · `font-size: 24px` · `letter-spacing: -.01em` · `color: var(--ink)`
- **Card CTA/link:** `background: var(--bg-2)` · `border: 1px solid var(--line)` · `border-radius: 999px` · `font-size: 13px` · weight 500

### Buttons

| Variant | Spec | Where used |
|---|---|---|
| **Primary CTA** | `bg: var(--ink)` · `color: #F4F0E8` · `padding: 14px 24px` · `radius: 999px` · weight 600 · `font-size: 15.5px` · deep box-shadow | Hero "Get dat job" |
| **Dark / nav** | Same ink bg · `padding: 9px 16px` · `font-size: 14px` · weight 500 | Nav, secondary CTAs |
| **Secondary** | `bg: var(--bg-2)` · `border: 1px solid var(--line)` · `radius: 999px` | Card links, sub-CTAs |

All buttons: `border-radius: 999px` (pill). No square or lightly-rounded buttons in the brand.

### Badges / tags
- **Benefit tags:** Geist Mono · `font-size: 11px` · `letter-spacing: .14em` · `text-transform: uppercase` · `color: var(--accent)`
- **Laurel / star decoration:** `color: var(--gold)` · SVG `16×32px`
- **Testimonial avatar:** `44×44px` · `border-radius: 50%` · `background: var(--bg-2)` · `border: 1px solid var(--line)`

### Footer
- `background: var(--ink)` · `color: #A6A39A`
- Column headings: `font-size: 13px` · weight 600 · `color: #E9E5DA`
- Links: `font-size: 13.5px` · `color: #8C8A82`
- Social icon tiles: `36×36px` · `border-radius: 9px` · `background: #1F2228` · `border: 1px solid #2A2E36`
- **Wordmark watermark:** large SVG text "getdatjob" · Geist Sans weight 600 · gradient mask white → transparent (decorative)

---

## Layout & spacing

- Max content width: `1180px` with `padding: 0 28px` (`.wrap`)
- Narrower content: `1003px` (`.wrap-85`)
- Section vertical padding: ~90px
- Border radius scale: `14px` (small tiles/tags) → `18–22px` (cards, images) → `999px` (pills)

---

## Copy & messaging

### Visa sponsorship language

The employer data comes from the USCIS LCA database — it tells us that a company **has sponsored in the past**, not that a specific open job will sponsor.

| Use | Avoid | Why |
|---|---|---|
| "visa sponsoring employers" | "visa sponsoring jobs" | We can claim the employer has sponsored before; we can't claim any individual job will |
| "sponsoring employers" | "jobs that sponsor visas" | Same reason |
| "employers who have sponsored visas" | "H-1B jobs" / "jobs with visa sponsorship" | Implies the job itself is a guaranteed sponsor |

**Rule of thumb:** subject is always the *employer*, never the *job/role/listing*. The employer has a sponsorship track record; the job posting does not.

---

## On-brand checklist

When reviewing a component or design for brand alignment:

- [ ] Background is cream `#F4F0E8`, not white
- [ ] Headlines use Instrument Serif; body/UI use Geist Sans; labels/tags use Geist Mono
- [ ] Buttons are pill-shaped (`radius: 999px`); primary always uses `var(--ink)` background
- [ ] Cards use `var(--card)` background + `var(--line)` border
- [ ] `--gold` appears only on decorative elements (laurels, stars), never on interactive elements
- [ ] Every line of a headline uses `var(--ink)` — including secondary lines; `var(--ink-3)` is never used on headlines
- [ ] Italic headline emphasis uses `var(--ink)` (near-black), **not** `var(--accent)` — `--accent` is for benefit tags and small labels only
- [ ] No hard white backgrounds or Tailwind `bg-white`
