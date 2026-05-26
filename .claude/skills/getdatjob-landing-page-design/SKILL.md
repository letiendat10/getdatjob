---
name: getdatjob-landing-page-design
description: >
  Interactive skill for layout and component decisions on getdatjob landing
  pages. Knows the existing section structure, established patterns
  (mobile-first, SEO-friendly, CSS Modules + Tailwind), and full component
  inventory. Guides decisions conversationally — you stay in the loop on every
  call. Trigger phrases: "design the page", "landing page layout",
  "section order", "page structure", "add a section", "what sections should
  we have", "where should X go on the page".
---

# getdatjob Landing Page Design Skill

You are a layout and component advisor for **getdatjob**. You know the existing codebase, established patterns, and what's already been built. Guide decisions conversationally — ask before assuming, surface options and constraints, let the user make the calls.

---

## Current Landing Page Structure

**Files:**
- Component: `web/src/app/components/LandingPage.tsx`
- Styles: `web/src/app/landing.module.css`
- Entry: `web/src/app/page.tsx` (passes `headline` + `body` props)

**Section order (top → bottom):**
1. **Announcement strip** — `bg: var(--ink)`, 40px tall, single centered line
2. **Nav / Header** — Sticky, frosted glass (`rgba(244,240,232,.85)` + backdrop blur), brand left + CTA pill right
3. **Hero** — Full-viewport, Instrument Serif h1 with italic `var(--accent)` phrase, sub copy, primary CTA, laurel trust bar (stats: jobs / employers / members), hero media placeholder
4. **Trusted by** — Label + 2-row infinite-scroll company logo marquee (row 1 scrolls left, row 2 scrolls right)
5. **Benefits** — "More than just a job board." — 4 alternating left/right image+content rows
6. **Visa types** — "Every visa, covered." — 4-up card grid on `var(--bg-2)`, each with stats + CTA link
7. **Founder** — Photo + Dat's story, Instrument Serif headline, italic "by a H-1B visa holder."
8. **Testimonials** — `TestimonialsCarousel` component
9. **FAQ** — Native `<details>/<summary>` accordion, 6 questions
10. **Footer** — 4 columns: brand + socials + AI links | jobs-by-visa | jobs-by-category | resources. Gradient wordmark watermark. Legal bar.

---

## Established Patterns

### Tech constraints
- **Framework:** Next.js App Router — no `useEffect`/`useState` in server components; use `"use client"` directive for interactive islands only
- **Styling:** CSS Modules (`.module.css`) for component styles + Tailwind utilities for fine-grained adjustments
- **Animations:** CSS-only via `@keyframes` in CSS Modules. No Framer Motion.
- **Images:** `next/image` for local assets; `<img>` for external CDN logos (with `eslint-disable` comment)

### Mobile-first
- All layouts start single-column, expand at breakpoints
- Fluid typography via `clamp()` (e.g. `clamp(38px, 4.6vw, 58px)` for hero title)
- Touch targets: minimum 44px
- Use `100svh` not `100vh` for viewport height (accounts for mobile browser chrome)
- Test at 375px, 768px, 1280px

### SEO-friendly
- **Semantic HTML:** `<header>`, `<nav>`, `<section>`, `<footer>`, `<article>` — not just `<div>`
- **Heading hierarchy:** One `<h1>` per page (hero), `<h2>` for section titles, `<h3>` for cards/items
- **Meta tags:** Export `metadata` object from `page.tsx` (Next.js App Router pattern)
- **Alt text:** All `<img>` tags need descriptive alt attributes
- **Structured data:** Add `application/ld+json` for JobPosting schema on jobs pages

### Layout containers
- `.wrap` — `max-width: 1180px`, `padding: 0 28px` (20px mobile)
- `.wrap-85` — `max-width: 1003px`, same padding (tighter, used for benefit rows)

---

## Component Reuse Guide

**Already exists — reuse before rebuilding:**

| Component | File | Reuse notes |
|---|---|---|
| `LandingPage` | `components/LandingPage.tsx` | Shell; takes `headline` (ReactNode) + `body` (string) |
| `TestimonialsCarousel` | `components/TestimonialsCarousel.tsx` | Drop in anywhere |
| `VisaSwap` | `components/VisaSwap.tsx` | Visa type toggle UI |
| Company logo marquee | Inside `LandingPage.tsx` | CSS animation, two rows |
| Laurel trust bar | Inside `LandingPage.tsx` | Stats with gold leaf SVGs |
| Visa cards grid | Inside `LandingPage.tsx` | 4-up, extend by adding cards |
| FAQ accordion | Inside `LandingPage.tsx` | Native `<details>` — no JS |
| Footer | Inside `LandingPage.tsx` | Full multi-column footer |
| `JobCard` | `kai/page.tsx` (inline) | Not yet a shared component — extract to `components/JobCard.tsx` if needed on landing |

---

## Anti-Patterns (Tried and Removed)

- **JS-based scroll animations** → replaced with CSS `@keyframes marquee`; GPU-accelerated, no layout thrash
- **Fixed sticky footer on mobile** → causes iOS Safari viewport issues; only use on Kai page
- **Full-page background images in hero** → hurts LCP; use placeholder + overlay pattern instead
- **`100vh` for full-viewport sections** → use `100svh`; `vh` miscalculates on mobile with browser chrome

---

## Kai Page vs. Landing Page

| | Landing | Kai |
|---|---|---|
| Background | `#F4F0E8` warm off-white | `#0E1116` near-black |
| Typography | Instrument Serif for headings | Geist Sans only |
| Nav | Frosted glass, CTA pill | Flat dark, minimal |
| Layout | Multi-section marketing page | Single-surface chat |
| Footer | Full multi-column | None |
| Announcement strip | Yes | No |
| Server component | Yes (mostly) | No — full `"use client"` |
| SEO priority | High | Medium |

---

## Design Decision Process

When adding a new section or page, work through in order:
1. **Can an existing component handle it?** Reuse before building.
2. **Where in the section hierarchy?** Above or below fold? Before or after social proof?
3. **Does it need interactivity?** If yes → `"use client"` island. Keep parent as server component.
4. **Mobile layout first** — what does it look like at 375px?
5. **Heading hierarchy check** — no skipping from `<h1>` to `<h3>`.
6. **Copy ready?** Don't design around placeholder text — use `getdatjob-copy` skill first.

---

## Implementation Notes

### Files
- `web/src/app/page.tsx` — all JSX/component logic
- `web/src/app/landing.module.css` — CSS Modules styles

**Tech stack:** Next.js App Router + Turbopack, CSS Modules, Vercel

### Hero section layout

The hero is a flex column that fills exactly one viewport minus the strip + nav. Layout rule:

- **Top-down:** banner → nav → hero padding (56px mobile, 28px desktop) → headline → body copy → CTA button → fixed spacing → media (fills remaining)
- **Bottom-up from fold:** 20px breathing room → laurels → fixed spacing above laurels → media

The media element uses `flex: 1` on both mobile and desktop to fill the remaining space between the CTA and the laurels. No `aspect-ratio` constraint — it scales to fit.

**Hero CSS (key rules):**

```css
/* Base (desktop) */
.hero {
  padding: 28px 0 20px;         /* 20px bottom = breathing room above fold */
  min-height: calc(100svh - 40px - 62px);  /* strip(40) + nav(62) */
  display: flex;
  flex-direction: column;
}
.hero-wrap { flex: 1; display: flex; flex-direction: column; }
.hero-media { flex: 1; min-height: 220px; border-radius: 22px; margin: 26px auto 0; max-width: 1040px; width: 100%; }
.hero-laurel { order: 5; margin: 28px auto 0; }   /* order:5 moves laurels after media visually */

/* Mobile (@media max-width: 640px) */
.hero { padding: 56px 0 20px; min-height: calc(100svh - 36px - 56px); }
                                /* strip(36) + nav(56) on mobile */
.hero-media { flex: 1; min-height: 0; margin-top: 28px; margin-left: 0; margin-right: 0; width: 100%; border-radius: 16px; }
.hero-laurel { order: 5; padding: 0; margin: 20px 0 0; }
.hero-title { font-size: clamp(36px, 8vw, 42px); }
```

**Key DOM order trick:**
In `page.tsx` the `hero-laurel` div appears FIRST in the DOM (before title/sub/cta/media) for semantic reasons. CSS `order: 5` moves it visually to the bottom without touching the DOM. Media and other siblings default to `order: 0`.

**svh unit:** Always use `100svh` (small viewport height), not `100vh`, for accurate mobile viewport calculation that accounts for browser chrome (address bar, tab bar). On desktop `svh = vh`.

**Strip + nav heights:**
| | Desktop | Mobile |
|---|---|---|
| Strip | 40px | 36px |
| Nav | 62px | 56px |
| Hero min-height | `calc(100svh - 102px)` | `calc(100svh - 92px)` |

### Footer wordmark alignment

The large "getdatjob" SVG wordmark at the bottom of the footer uses a dynamic padding trick to align its left/right edges exactly with the layout container (`.wrap`):

```css
.footer-mark {
  display: block;
  background: var(--ink);
  line-height: 0;
  overflow: hidden;
  /* mirrors .wrap: inset = half space beyond max-width + 28px padding */
  padding: 0 max(28px, calc((100% - 1180px) / 2 + 28px));
}
.footer-mark svg {
  overflow: visible;  /* SVG text may slightly overshoot viewBox — let container clip */
}
/* Mobile */
.footer-mark { padding: 0 20px; }
```

- `max()` clamps so padding never goes below 28px (when viewport < 1180px)
- `overflow: hidden` on the container clips any slight SVG text overshoot
- `overflow: visible` on the SVG prevents the SVG element itself from clipping its own content

### Layout container (`.wrap`)

```css
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 28px; width: 100%; }
/* Mobile */ .wrap { padding: 0 20px; }
```

### Announcement strip

Banner text: `$120K pre-seed round closed to fuel working visa holders' dreams`

---

## Reference
Visual language (colors, fonts, tokens) → `getdatjob-branding` skill
Copy for any section → `getdatjob-copy` skill
