# QA Handoff — Company logo correctness (`company_domain_url` single source)

> For a fresh Claude Code session with **no prior context**. Branch: `claude/determined-kirch-f7e366`
> (worktree `/Users/dat/getdatjob/.claude/worktrees/determined-kirch-f7e366`). Supabase prod project:
> `tdgptapfspleoobiyiqx`. logo.dev publishable token: `pk_YdvbuXypSrijGM3tlqKDqA`.
>
> **Status: implemented + unit-verified, NOT end-to-end validated. Do NOT treat as shippable** — no
> `next build`, no browser, no live-site or intake E2E run was performed (see "Could not validate").

## 1. Goal
Job-card/avatar logos render client-side from `employers.company_domain_url` via
`https://img.logo.dev/<domain>`. That domain is derived from the LCA **POC email**, which for some
employers is a third-party **law firm** (HP → `hp@fragomen.com`) or **SaaS/mail vendor**
(Medline → `…@medlinehr.zendesk.com`) → logo.dev returns the *wrong* brand (HP showed Fragomen's logo on
139 live cards). Goal: make `employers.company_domain_url` the single source of truth, correct the bad
rows, collapse the duplicated frontend logo logic into one component, and harden quarterly intake so new
employers don't recur (flag-for-review, never silently store a law-firm domain).

## 2. Files changed (worktree branch — NOT committed)
Code (run `git -C <worktree> diff` to see all):
- **`scrapers/domain_resolve.py`** (NEW) — shared resolver: `resolve_company_domain(poc_email, employer_name)
  -> (domain, needs_review, reason)`. Law-firm/vendor lists + curated `BRAND_DOMAIN_FIX` + name-derived guess.
- **`scrapers/00_quarterly_intake.py`** — replaced raw `split("@")` domain derivation with the resolver;
  prints a "review (yes/no)" list of flagged employers.
- **`scrapers/01_process_lca.py`** — deleted local `domain_from_poc()` + lists; now imports the resolver; prints flagged.
- **`web/src/app/components/CompanyAvatar.tsx`** — rewritten as the SOLE logo source; exports `logoUrl()`;
  removed all `DOMAIN_OVERRIDES`/`LOGO_OVERRIDES`/`NAME_LOGO_OVERRIDES`/`companyDomain()`. Now: `domain ? logo.dev : monogram`.
- **`web/src/app/components/HeroCardStack.tsx`** — uses `logoUrl()` (env token) instead of a hardcoded `pk_…` token.
- **`web/src/app/{jobs/jobs-client,kai/page,me/me-client,me/matches-panel}.tsx`** — removed the DEAD duplicated
  logo override maps + `companyDomain()` (these were never called). `normalizeCompanyName()` (name display) was KEPT.

DB (prod — **already applied via `execute_sql`, NOT a migration file**): `employers.company_domain_url` corrected for:
| id(s) | employer | → domain |
|---|---|---|
| 383 | HP Inc. | `hp.com` |
| 100, 68620 | Medline Industries | `medline.com` |
| 2551, 186998, 63904 | SCI (Shared Resources/Services/Financial) | `sci-corp.com` |
| 720 | Southwest Airlines | `southwest.com` |
| 1344 | Coupang Global | `coupang.com` |
| 3068 | Nissan North America | `nissanusa.com` |
| 116, 235, 504, 57864, 89353, 90550, 91781, 101927, 115001, 18275 | Goldman Sachs entities | `gs.com` |
| 2350, 172619, 10271, 10280 | Shopify entities | `shopify.com` |
| 364 | Block, Inc. | `block.xyz` |
| 208, 8674 | SoFi (Social Finance / SoFi Bank) | `sofi.com` |

## 3. Expected user-facing behavior
- Corrected employers show the **correct brand logo** on every surface that renders `CompanyAvatar`.
  e.g. HP card shows the HP roundel (not the Fragomen law-firm logo); Medline shows Medline; SCI/Southwest/
  Coupang/Nissan show real logos instead of monograms; Block shows the Block grid (not Square); SoFi shows SoFi.
- The **frontend refactor itself changes nothing visually** (same logo.dev URLs) — the visible fix comes
  entirely from the DB column. So a before/after diff is only observable for the 10 corrected employers.
- Propagation timing: `/me/job-matches` and `/kai` read a **live RPC** (immediate); `/jobs` has a **~30-min
  `unstable_cache` + CDN `s-maxage`** (delayed). Landing hero is unchanged (Anthropic/Stripe/Airbnb).

## 4. Routes to verify
- **`/jobs`** — only HP & Medline of the fixed set have live jobs (139 / 152). Filter/search "HP" or "Medline";
  confirm the avatar is the real brand. (Wait out the 30-min cache, or verify via `/me`/`/kai` which are live.)
- **`/me/job-matches`** — auth required; live RPC. Best place to see the fix immediately if HP/Medline are in matches.
- **`/kai`** — live RPC; search a query that surfaces HP or Medline roles.
- **`/`** (landing) — hero logos still render (Anthropic/Stripe/Airbnb); confirms the `HeroCardStack` token swap didn't break.
- Data source of truth: `jobs_with_details` (/jobs), `search_jobs_kai` / `jobs_kai_view` (/kai, /me) — all select `e.company_domain_url`.

## 5. Commands already run (and what they proved)
- DB `SELECT`s → the 10 rows show the new domains; **real Fragomen (id 96475) still `fragomen.com`**, **KPMG LLP still `kpmg.com`** (legit owners untouched).
- `curl -s -o /dev/null -w "%{http_code}" "https://img.logo.dev/<domain>?token=pk_YdvbuXypSrijGM3tlqKDqA&fallback=404"` for all 8+2 fixed domains → **200** (logo.dev has a real logo for each).
- Downloaded + **visually confirmed** the actual PNGs for `hp.com`, `medline.com`, `sci-corp.com`, `block.xyz`, `sofi.com` = correct brands.
- **Top-300-by-LCA contamination scan** (joined to FY2026_Q1 `AGENT_ATTORNEY_EMAIL`): only **HP & Medline** are genuine 3rd-party-domain contaminations (both fixed); EY = false positive (`ey.com` is its own); ~69 others are correct acronym/parent brands.
- `cd web && npx --no-install tsc --noEmit` → **no TypeScript errors** (incl. all changed files).
- `python3 -c "ast.parse(...)"` on the 3 scraper files → **parse OK**; no dangling `domain_from_poc` refs.
- Dry-ran `resolve_company_domain` on known cases + the exact `df.apply(axis=1).map()/.loc[]` pattern → correct (HP→hp.com flagged, Medline→medline.com auto, real Fragomen/KPMG kept, gmail→None).

## 6. Exact known risks
1. **DB edits are not a migration.** The 10 corrections were applied directly via `execute_sql` on prod. They are
   NOT reproducible from git and NOT in a migration file; a fresh DB/restore won't have them. (`BRAND_DOMAIN_FIX`
   in `domain_resolve.py` reproduces most at the *next* intake, but the one-time corrections live only in prod now.)
2. **Name-guess fallback removed.** `CompanyAvatar` no longer guesses `<stem>.com` when `domain` is null → such rows
   show **initials**. Safe today (active-job employers have 100% domain coverage, verified) but a brand-new/edge
   employer with a null domain would show initials instead of a guessed logo.
3. **HeroCardStack depends on `NEXT_PUBLIC_LOGO_DEV_TOKEN`** (was hardcoded). If the env var is missing in any
   environment, hero logos fall back to monogram/blank. (Present in `web/.env.local`; confirm in Vercel.)
4. **Intake scripts not run E2E.** Both `00`/`01` are wired but were NOT executed against the real Excel (they
   mutate prod / need env). Only the helper + pandas pattern were validated on synthetic rows.
5. **`registrable()` is last-2-labels only** — multi-part ccTLDs (`co.uk`, `com.au`) aren't special-cased (none
   currently on the board; a future such POC could be mis-grouped).
6. **`BRAND_DOMAIN_FIX` is a hand-curated map** in the scraper; new domain-variant cases need manual additions.

## 7. Things I could NOT validate
- **No browser/dev-server check** — never ran `preview_start`/`next dev`; the corrected logos were NOT seen
  rendering on the actual `/jobs`, `/kai`, `/me` pages in a browser. Verified only at the DB + logo-image + typecheck layers.
- **No `next build`** — only `tsc --noEmit`. ESLint and full RSC/build-boundary checks were not run.
- **Live site not re-checked post-cache** — the `/jobs` 30-min cache had not elapsed; did not confirm the board visually updated.
- **Intake `00`/`01` not run** against the real DOL Excel end-to-end.
- **~8 zero-job law-firm-POC employers NOT applied** (pending owner yes/no): SCAD→`scad.edu`, Urban Outfitters→`urbn.com`,
  StoneX→`stonex.com`, SSM Health→`ssmhealth.com`, Dean Health→`deancare.com`, Altimetrik→`altimetrik.com`, Frame→`frame-store.com`, Krane→TBD.
- **Block siblings not addressed** — only `Block, Inc.` (364) → `block.xyz`; Afterpay/Cash App/Square* entities still on `squareup.com` (Square logo); not validated as desired.

## 8. DB rows / queries to check
```sql
-- (a) the corrections landed (expect the 10 employers above on their new domains)
SELECT id, name, company_domain_url
FROM employers
WHERE company_domain_url IN
 ('hp.com','medline.com','sci-corp.com','southwest.com','coupang.com',
  'nissanusa.com','gs.com','shopify.com','block.xyz','sofi.com')
ORDER BY company_domain_url, name;

-- (b) legit owners untouched (Fragomen must stay fragomen.com; KPMG stay kpmg.com)
SELECT id, name, company_domain_url FROM employers WHERE id = 96475 OR name ILIKE '%KPMG%';

-- (c) no remaining active-employer domain is an obvious law firm / vendor
--     (re-derive: registrable POC domain shared across unrelated employers). Expect HP/Medline gone.
WITH reg AS (
  SELECT e.id, e.name, e.lca_count, e.company_domain_url,
         (SELECT count(*) FROM jobs j WHERE j.employer_id=e.id AND j.is_active) AS active_jobs
  FROM employers e)
SELECT * FROM reg
WHERE active_jobs > 0
  AND lower(company_domain_url) IN ('fragomen.com','bal.com','immigrationlaw.com','zendesk.com','medlinehr.zendesk.com')
ORDER BY active_jobs DESC;
```
logo.dev spot check (shell): for each fixed domain,
`curl -s -o /dev/null -w "%{http_code}\n" "https://img.logo.dev/hp.com?token=pk_YdvbuXypSrijGM3tlqKDqA&fallback=404"` → expect `200`.

## 9. Shippability
**NOT proven shippable.** Data, types, and resolver logic are validated; browser, `next build`, live-site
(post-cache), and intake E2E are **not**. To clear for ship, QA must: (1) `cd web && npm run build` clean;
(2) visually confirm HP & Medline logos on `/jobs` (after cache) and on `/me`/`/kai` (live); (3) optionally
dry-run intake against the latest DOL Excel and eyeball the printed "review (yes/no)" list. Until then:
*implemented, unit-verified, not end-to-end validated.*
