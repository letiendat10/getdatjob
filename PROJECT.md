# getdatjob — Master Plan

---

## The idea

getdatjob = job board (think TrueUp - depth, live job data, company intelligence) × verified immigration records (think DOL LCA data as filter lens). Built by H1B visa holder for other visa holders. Target: H-1B/E-3/TN visa holders who want a verified source of job postings during their job search, especially after a layoff and during the limited 60-day grace period.

---

## Demand signal

- H1B visa holders are under immersive pressure to find a new job in time
	- Apr 2026: ["Three weeks left on H-1B"](https://americanbazaaronline.com/2026/04/23/three-weeks-left-on-h-1b-visa-holder-turns-to-reddit-for-advice-479548/) → viral Reddit, national press
	- Jan 2026: ["Can you re-enter US after H-1B layoff?"](https://americanbazaaronline.com/2026/01/08/can-you-re-enter-us-after-an-h-1b-layoff-reddit-post-raises-alarm-472820/) → viral
- The current immigration climate worsens it
	- Getting worse: USCIS issuing deportation notices within 60-day grace period (since Feb 2025)
- They formed a social/community group on Reddit, Facebook
	- [r/h1b](https://www.reddit.com/r/h1b), [r/f1visa](https://www.reddit.com/r/f1visa), Facebook "H1B and Green Card Queries" — daily panic, tens of thousands of members
- https://migratemate.co claimed 30K+ users after 1 year launch
- Addressable population in full year 2024: around 616K visa holders in 2024
	- H-1B: 188,400 new and 407,625 adjudications
	- TN: 16,000 adjudications
	- E-3: 3,940
- The website traffic:
- H1Bgrader
- Migratemate

---

## Competitive landscape

| Player | Strength | Gap |
|---|---|---|
| [MyVisaJobs](https://www.myvisajobs.com) (2006) | Deep DOL/USCIS data | 2006 UX, trust issues, allegedly extorts companies |
| [Jobright.ai](https://jobright.ai) | Best UX, VC-backed ($7.7M) | Broad — not immigrant-native brand |
| [Migrate Mate](https://migratemate.co) | Clear immigrant focus | Thin product, paywalled early |
| [H1BGrader](https://h1bgrader.com) | Clean data lookup | Not a job board |
| [TrueUp](https://trueup.io) | Best job intelligence, 9K+ companies | Not visa-aware at all |

**The gap**: nobody fully understands the needs/urgency of a laid off H1B visa holder and the tools they need.

---

## User problem statement

They are looking for jobs that will sponsor their visa.

User pain points:
Jobs quality: not fresh, apply too late
Sponsorship: no confidence, rejected during interview

---

## User stories / Product offerings


### getdatjob helps visa holders navigate their job search more effective (time savings and confidence):
- Target audience: main focus is H-1B but this applies for E-3, TN as well — all included, labeled on each job card
- User stories:
	- Find and apply for visa sponsored jobs that are verified based on historical employer data on USCIS
	- Chat with AI to find those jobs
	- Get alerted according to your preferred frequency so you are first to apply
	- If you're laid off with a 60 day grace period: navigate the timeline

---

## The reason to believe:

- Live job postings that are verified against historical data on government source
- Founder who has 2x successfully found H1B jobs after being layoff – always in legal status, without leaving the US

---

## Data architecture

### DOL LCA historical data (primary)
- Every Labor Condition Application filed with the US Dept of Labor (OFLC)
- Fields: employer name, FEIN, job title, wage offered, wage level (I–IV), city/state, filing date, visa class
- Visa classes: H-1B, H-1B1, E-3, TN — all included, labeled on each job card
- Source: `dol.gov/agencies/eta/foreign-labor/performance` — quarterly Excel files, FY2020–present
- Coverage: top 500 employers by LCA volume (no minimum threshold)
- h1bdata.info = same source, skip it

To do next: go back to cover 2025, 2024, and 2023.

### ATS job feeds (live listings)
Public APIs, no auth required. All 9 ATS types now supported end-to-end (detect + fetch):

| ATS | Detection endpoint | Fetch endpoint | Slug format |
|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` — 200 + `jobs` key | same + `?content=true` | brand name e.g. `stripe` |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` — 200 + array | same | brand name e.g. `netflix` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` — 200 + `jobs` count > 0 | same | brand name e.g. `openai` |
| Workday | CXS POST: `{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}/jobs` | same | `{tenant}.{instance}/{jobsite}` e.g. `capitalone.wd12/Capital_One` |
| iCIMS | `{slug}.icims.com/jobs/search` — 200 (redirects to login = valid) | HTML scrape of same | subdomain e.g. `us-careers-rivian` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` — check `totalFound > 0` | same with pagination | company slug e.g. `ATT` |
| BambooHR | `{slug}.bamboohr.com/jobs/` — 200 + stays at slug domain | embed2.php HTML parse | brand name e.g. `asana` |
| Workable | `workable.com/api/accounts/{slug}` — 200 + `name` key | same + `?details=true` | brand name e.g. `typeform` |
| Amazon | custom scraper (amazon.jobs search.json API) | same | N/A (slug ignored) |

**Detection order** (by H-1B sponsor prevalence): Greenhouse → Lever → iCIMS → SmartRecruiters → Ashby → BambooHR → Workable

**Workday note**: Jobsite names are non-guessable (tenant `collaborative` = Cognizant, `ouryahoo` = Yahoo, `ffive` = F5). Best discovery method: `site:myworkdayjobs.com "{company}"` web search → extract URL → verify via CXS API. Workday is NOT in the auto-detect loop — added manually or via `detect_workday_urls.py`.

**employer_ats as of 2026-05-23**: 100 entries — workday (43), greenhouse (37), smartrecruiters (9), amazon (5), lever (4), ashby (2)


### Sponsorship confidence signal (per job)
1. Company not in DOL → exclude
2. Job description contains "will not sponsor" language → exclude
3. Company in DOL + title matches LCA history (last 36 months) → **Sponsored before**
4. Company in DOL + no match → **H1B Friendly**

Title matching is fuzzy ("Senior Software Engineer" ≈ "Software Engineer II"). Mapping sheet = separate session.

### Database — Supabase (Postgres)
| Table | Contents |
|---|---|
| `employers` | id, name, FEIN, lca_count, top_visa_class, last_filing_date |
| `employer_ats` | employer_id, ats_type, slug, verified_at |
| `lca_filings` | employer_id, job_title, soc_code, wage_offered, wage_level, city, state, filing_date, visa_class |
| `jobs` | id, employer_id, title, location, url, posted_at, ats_source, ats_job_id, description_text |
| `job_signals` | job_id, confidence_tier, matched_lca_count, description_flag, visa_class |

Refresh: LCA quarterly, ATS jobs daily via GitHub Actions cron.

---

## Website

### Main landing page:
to explain what we do
what you can use us for
why you should use us
Trusted by H1B visa holders at companies (pulled from members’ linkedin: current and all previous employers)
pricing

### Visa sponsored Jobs: most critical
Filters: Company. Viewed/Favorite.
X jobs updated last week. X total jobs. X employers.
Sort by.
Left panel: list of jobs
Compapny logo. Company name.
Job title
Location. XX days/hours ago.
Viewed. 
Right panel: details of job post
Company logo. Company name.
Job title
Location. XX days/hours ago
Range of salary. Level. Years of experience.
Department. Industry. Sponsorship confidence signal. XX LCA filed in 2025. Last LCA filed.
Department categories (inferred from job title, keyword-based, null if unclassifiable): AI / ML, Data, Security, Product, Design, Platform / DevOps, Sales, Marketing, Finance, Facilities, Operations, Legal, HR / People, Customer Success, Engineering.
Level categories (inferred from job title): Intern, Junior, Mid-level, Senior, Principal / Staff, Lead / Manager.
Save. Share. Sign up to apply.
To do next: company logo

### Sign up flow and paywall:
- User accounts + LinkedIn OAuth
To do next: this one

### ResumeAI:
- User upload resume. AI analyse and recommend how to restructure with more info if possible.

### Timeline:
- Timeline: when laid off?
- Different view options: calendar
- Application tracker
To do next: this one

### [Sub] company list:
- For later: Investor / industry tagging

### Company pages:
- Company pages: move per-company signals (Active Transfers, LCA Q1 count, transfers Q1 count) off the job card and onto a dedicated company profile page

### AI Chat (WhatsApp):
- User texts a WhatsApp number → AI answers job search / visa questions
- Powered by Claude; context: user's profile, job board data, LCA data
- WhatsApp via Twilio or WhatsApp Cloud API
- To do next: this one

### Job alerts:
After a Kai conversation surfaces results, users can opt in to email alerts when new matching jobs appear.

**User experience:**
- After Kai returns job results, show an "Alert me" chip alongside "Show more", "Change location", etc.
- Clicking "Alert me" → modal: enter email + pick frequency (daily / weekly)
- Alert email links to `/alerts/[token]` — a portal page showing live matches for that alert's saved filters
- Option A (inline jobs in email body) is v2 — start with portal link (Option B), simpler and still high value
- Every email has unsubscribe + frequency change link in footer

**Architecture:**
- New Supabase table: `job_alerts` (id, email, filters JSONB, frequency ENUM['daily','weekly'], last_sent_at TIMESTAMPTZ, token UUID, created_at)
- New portal route: `/alerts/[token]` — server component, queries `jobs_kai_view` with saved filters
- Scheduled Supabase edge function: runs daily, queries each active alert for new postings since `last_sent_at`, sends email if matches found
- Email service: Resend or Supabase built-in SMTP
- Kai UI change: add "Alert me" to `POST_RESULT_CHIPS` in `web/src/app/kai/page.tsx`

**Dependency:** Build `kai-dev` QA skill first so regression coverage exists before adding alert logic to Kai's flow.

**Why this matters:** Visa job markets move fast. A user searches Monday, misses a posting Wednesday. Alerts close the gap and bring users back passively. Highest-value retention feature before paywall.

### Other ideas:
- Job title similarity mapping sheet
- More "no sponsor" keyword patterns (user to provide examples)


---

## Skills (Claude Code)

Project-specific skills live in `.claude/skills/`. Invoke by name or trigger phrase in any session.

| Skill | Path | Triggers |
|---|---|---|
| `getdatjob-branding` | `.claude/skills/getdatjob-branding/SKILL.md` | "match the brand", "brand colors", "what font", "component style", "design tokens", "keep it on-brand" |
| `getdatjob-copy` | `.claude/skills/getdatjob-copy/SKILL.md` | "write copy for", "hero section", "CTA for", "what should this say", "tagline", "subject line" |
| `getdatjob-landing-page-design` | `.claude/skills/getdatjob-landing-page-design/SKILL.md` | "design the page", "section order", "page structure", "add a section", "where should X go" |
| `getdatjob-product-strategy` | `.claude/skills/getdatjob-product-strategy/SKILL.md` | "let's build X", "new feature idea", "product strategy for", "what should we build next" |
| `getdatjob-kai-dev` | `.claude/skills/getdatjob-kai-dev/SKILL.md` | "test Kai", "QA Kai", "Kai is saying...", "update Kai's persona", "Kai keeps..." |
| `weekly-progress-update` | `.claude/skills/weekly-progress-update/SKILL.md` | "progress update", "weekly update", "update the master plan", "what did we do this week", "how are we tracking" |

---

## Company setup

- [Stripe Atlas](https://stripe.com/atlas) → Delaware C-Corp, EIN, Stripe (~$500)
- [Mercury](https://mercury.com) → business bank account
- Domain → [Namecheap](https://namecheap.com) or Cloudflare (~$10)
- Co-founder: need a technical person (engineer, ideally also an immigrant)

---

## Week-by-week plan

### Week 1 — Foundations
- Incorporate via Stripe Atlas
- Use Gumroad or Stripe Payment Link
- Register domain + dead-simple Framer landing page: "Only tech jobs that will actually sponsor your visa" + email waitlist

### Week 2 — Data pipeline and core product pages (in progress → last mile)
- ✅ DOL LCA Q1 FY2026 downloaded
- ✅ Greenhouse ATS scraper built (33 companies, old approach)
- ✅ New pipeline: top 500 employers from DOL → ATS detection → Supabase (scripts complete)
- ✅ Daily job pull cron running (03_pull_jobs.py)
- ✅ Company logo enrichment (04_enrich_domains.py, 06_apply_domains.py, qa_logos.mjs)
- ✅ Next.js + Supabase live queries + Vercel deployed
- ✅ Jobs page: live Supabase queries, search, filter, job cards, details, load optimized
- ✅ Landing page: built, mobile optimized, A/B hero variants (/a/ /b/ /c/ /d/), testimonials, VisaSwap
- 🔄 ATS slug verification: Google Sheet created, pending manual review (5/15)
- [ ] Sign up and Paywall
- [ ] Timeline
- [ ] AI Chat (WhatsApp integration)
- [ ] Job alerts

### Week 3 — Manual MVP (no code UI)
- Post in communities as Dat: r/h1b, r/f1visa, r/cscareerquestions, Facebook "H1B and Green Card Queries", LinkedIn
- Goal: 5 real user feedback
- Landing page: resume

### Week 4 — First revenue
- Paywall: free = 50 jobs, paid ($15/mo) = all jobs + email alerts
- DM most active users → offer free access for feedback call
- Goal: 10 paying users

### Week 5 — 

### Week 7–8 — Growth (Dat's superpower)
- Lifecycle email flow: Day 0 welcome, Day 3 companies with transfer LCAs, Day 7 re-engagement, Day 14 digest
- Paid ads: $500–1K on Reddit + LinkedIn targeting OPT/H-1B keywords (Dat ran $1.75M in ads — unfair advantage)
- Weekly community posts

### Week 9–10 — Press + First Round angle
- Weekly LinkedIn/Substack: personal immigrant story + product insights
- Reach out to Julia Govberg (First Round Fast Track) — 100 paying users, want feedback
- Target: 100 paying users, $1,500 MRR

---

## QA test: remove
- Duplicate job cards (same title, different locations)
- "United States" location only
- Salary = company-wide LCA median, not job-specific — label it better

---

## Success metrics

| Week | Metric | Signal |
|---|---|---|



## Update as of 5/23:

### 1. Done since last update (5/21 → 5/23)

**ATS expansion — hit 100 employer mappings ✅**
- `employer_ats` grew from 5 → 100 confirmed live entries
- Workday: 43 companies mapped by manual web search (`site:myworkdayjobs.com "{company}"`) — discovered non-obvious tenant names (Cognizant=`collaborative`, Yahoo=`ouryahoo`, F5=`ffive`, Capital One=`capitalone.wd12`, etc.)
- SmartRecruiters: 9 companies
- Amazon: 5 legal entities (same custom scraper)
- Ashby: 2 companies (Snowflake, OpenAI) — found by fetching careers page HTML
- Fixed incorrect entries in `SLUG_OVERRIDES` (many companies were wrongly flagged as Greenhouse when they use Workday)
- Fixed `check_ashby` bug — was using wrong API URL

**ATS pipeline expanded**
- Added `check_icims`, `check_bamboohr`, `check_workable` to `02_detect_ats.py`
- `ATS_CHECKS` reordered by H-1B sponsor prevalence: Greenhouse → Lever → iCIMS → SmartRecruiters → Ashby → BambooHR → Workable
- Added `fetch_bamboohr` to `03_pull_jobs.py` FETCHERS dict
- Total ATS types supported end-to-end: 9

### 2. What we learned
- Workday jobsite names are never guessable — brute force of 42 patterns found 0/33 companies. Only reliable method: web search for indexed job URLs
- iCIMS: many large companies use custom domains, not `{slug}.icims.com` — custom domains need manual detection
- BambooHR `embed2.php` returns 200 for any slug including fake ones — use `/jobs/` redirect behavior instead (valid = stays at subdomain, invalid = bounces to www.bamboohr.com)
- Workable old widget endpoint returned 200 for any slug; new `workable.com/api/accounts/{slug}` endpoint is reliable
- SmartRecruiters must check `totalFound > 0` not just HTTP 200
- `posted_at` is null for Workday, iCIMS, BambooHR jobs (APIs return relative strings). Default "Past week" filter hides all of these.

### 3. Remaining — in order

| # | Task | Why it's next |
|---|---|---|
| 1 | Run `03_pull_jobs.py` | Pull Workday (43) + SmartRecruiters (9) + Amazon (5) + Ashby (2) jobs — big volume |
| 2 | Fix null `posted_at` display | Workday jobs invisible under default 7-day filter — use `last_seen_at` as fallback |
| 3 | Sign up + email capture | Need this before community launch to retain visitors |
| 4 | Paywall | Free = 10 jobs preview, paid = all jobs + alerts |
| 5 | Job alerts | Highest-value feature for laid-off users in grace period |
| 6 | Timeline | Shows visa countdown, application tracker |
| 7 | AI Chat / WhatsApp | Viral hook, but needs auth + alerts first |

### 4. The bottleneck
Sign up is the gate. Without email capture, every visitor who doesn't convert is gone forever. Highest-leverage build next.

### 5. Week 3 goal
Community launch — r/h1b, r/f1visa, r/cscareerquestions, Facebook "H1B and Green Card Queries", LinkedIn. Target: 5 real pieces of user feedback and first email signups.

## Update as of 5/21:

### 1. Done since last update (5/14 → 5/21)

**Data pipeline**
- `04_enrich_domains.py` + `06_apply_domains.py` built — company domains enriched for logo resolution
- Zoox job scraping fixed — was only pulling partial listings, now pulls all
- Inactive job postings handled in sync — stale jobs now marked inactive instead of ghosting

**Jobs page**
- H1B filter added to job listings
- Job detail panel added (right panel with full posting)
- Location filtering fixed (was showing wrong locations)
- Jobs page display + labels fixed
- Jobs page styling polish + Remote field added
- Logo added to each job card — with Block.xyz logo correction
- Load time optimized — API route identified as bottleneck, addressed

**Landing page** *(from zero to live this week)*
- Researched YC-playbook landing pages (Astor.app, Standout.work as reference)
- Built full landing page v2 — `LandingPage.tsx` (27KB), `TestimonialsCarousel.tsx`, `VisaSwap.tsx`
- Mobile spacing + scroll performance fixed
- Company logo marquee built + mobile bug fixed
- Header wordmark linked to landing page
- A/B hero copy variants live at `/a/` `/b/` `/c/` `/d/`

**Infrastructure**
- 1 routine created: `getdatjob-daily-pull` — runs every day at 7:03 AM, pulls fresh ATS jobs → Supabase + signal scoring. Running since 5/16.
- Site live at `getdatjob.vercel.app`

---

## Update as of 5/14:

### What's been built this session
- **App renamed**: VisaTrack → **getdatjob** (`web/src/app/page.tsx`)
- **Supabase** fully live — `https://tdgptapfspleoobiyiqx.supabase.co`
  - 5 tables created + schema at `schema.sql`
  - **500 employers** + **38,309 LCA filings** loaded
  - **28 companies** mapped to ATS (Greenhouse/Lever)
  - **5,234 jobs** pulled with confidence tier scoring:
    - 1,682 Verified (title matched LCA history)
    - 3,201 Likely (company in DOL, no title match)
    - 0 Excluded
  - Next.js client wired: `.env.local` + `src/lib/supabase.ts` + `@supabase/supabase-js`
- **Three Python pipeline scripts** at `scrapers/`:
  - `01_process_lca.py` — quarterly: DOL xlsx → employers + filings → Supabase
  - `02_detect_ats.py` — one-time + reruns: ATS slug detection
  - `03_pull_jobs.py` — daily: job pull + sponsorship signal scoring
- **Vercel MCP** available (connected this session, not yet used)

### Next session — pick up here (in order)
**Goal: live job board with top 20 tech companies, valid apply links, basic employer filter, job details (title, company, salary range)**

1. **Curate top 20 tech companies** — pick from employer_ats by LCA volume + brand recognition
2. **Verify ATS slugs** — confirm each slug returns valid jobs; fix Uber, Snowflake, DoorDash, OpenAI, Snap, Coinbase
3. **Re-run 03_pull_jobs.py** — scoped to verified 20 companies
4. **Wire Next.js to Supabase** — replace static jobs.json with live queries (`src/lib/supabase.ts` is ready)
5. **Verify all apply links** — spot-check that each link points to a real, live job posting
6. **Add employer filter** to job board UI
7. **Job cards** — title, company, salary range visible
8. **Deploy to Vercel**

### Current Supabase data snapshot
| Table | Rows |
|---|---|
| employers | 500 |
| lca_filings | 38,309 |
| employer_ats | 28 |
| jobs | 5,234 |
| job_signals | 5,234 |

### ATS-mapped companies (28 total)
Greenhouse: Databricks, Stripe, Pinterest, Waymo, Airbnb, Block, Reddit, Qualtrics, Zscaler, Cloudflare, CoreWeave, Okta, Anthropic, SoFi, Roblox, Robinhood, Instacart, HubSpot
Lever: Zoox, Netflix

### Key file paths
```
/Users/dat/getdatjob/
  PROJECT.md                          ← this file (master plan)
  schema.sql                          ← Supabase schema
  data/raw/                           ← put LCA xlsx files here (not in Drive sync)
  scrapers/
    config.py                         ← Supabase URL + service role key
    requirements.txt                  ← pip install -r requirements.txt
    01_process_lca.py                 ← quarterly: LCA → Supabase
    02_detect_ats.py                  ← one-time + reruns: ATS detection
    03_pull_jobs.py                   ← daily: job pull + signal scoring
  web/
    src/app/page.tsx                  ← all UI logic (still reads static JSON)
    src/lib/supabase.ts               ← Supabase client (ready to use)
    .env.local                        ← Supabase URL + anon key
    .claude/launch.json               ← preview server (name: visatrack, port 3000)
```

### Known issues to fix next session
- `data/` and `scrapers/` directories get wiped by Google Drive sync — they live outside Drive now at `/Users/dat/getdatjob/` but Drive may still interfere. Consider moving `web/` outside Drive too.
- Uber/Snowflake/DoorDash/OpenAI/Snap/Coinbase slugs need fixing

---



