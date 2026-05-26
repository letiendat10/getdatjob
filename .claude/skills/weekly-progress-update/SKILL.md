---
name: weekly-progress-update
description: "Generate a progress update for the getdatjob project by reviewing recent Claude Code sessions and summarizing what was built, what was learned, and what's next. Use this whenever the user says things like 'progress update', 'weekly update', 'update the master plan', 'what did we do this week', 'how are we tracking', 'what have we built', or 'check our progress'. Always use this skill for getdatjob progress/status questions — do not answer from memory alone."
---

# Weekly Progress Update — getdatjob

You are acting as the project manager for getdatjob, a visa sponsorship job board. Your job is to compile an honest, well-structured progress update, show it to the user for approval, then (and only then) append it to the master plan.

## Step 1 — Find the date of the last update

Read `/Users/dat/getdatjob/PROJECT.md`. Find the most recent `## Update as of <date>:` entry. That date is your "last update" boundary — you only cover sessions after it.

## Step 2 — Review sessions since the last update

Use `mcp__ccd_session_mgmt__list_sessions` to get all sessions. Filter to only getdatjob sessions (cwd = `/Users/dat/getdatjob`) that occurred after the last update date.

For each session, the title is your primary signal. Group by theme:
- Auth + onboarding (LinkedIn OAuth, Kai-first flow, /me page)
- Data pipeline (scrapers, ATS detection, Supabase)
- Jobs page (UI, filters, cards, performance)
- Landing page (design, copy, mobile, A/B tests)
- Kai (persona, copy, intake questions)
- Infrastructure (deploy, cron, domain, env, legal pages)
- Bug fixes
- Non-getdatjob sessions → exclude

Also check:
- `mcp__scheduled-tasks__list_scheduled_tasks` — how many routines are active, when they last ran
- `ls /Users/dat/getdatjob/scrapers/` and `ls /Users/dat/getdatjob/web/src/app/` — new files as proof of work
- The available skills list in the system prompt — note any new skills created since the last update

## Step 2.5 — Sprint ticket audit (session → Linear reconciliation)

Before pulling sprint data, verify that all shipped work has a Linear ticket.

**Rules for what counts as a ticket:**
- ✅ **Ticket**: session where something shipped or was fixed — bug fix, feature built, scraper/script deployed, optimization landed, tool created
- ❌ **No ticket**: automated crons ("Getdatjob daily pull", any scheduled routine), brainstorm/discussion/planning sessions (title contains "brainstorm", "strategy", "aspirations", "analysis", "research", "overview", "plan", "notes", "replica", "inventory", "options", "discussion"), competitor/reference research

**How to audit:**

1. Get sprint boundaries from Linear — do NOT assume Mon→Sun calendar math:
   ```
   mcp__768703e1-6130-4d9e-bdc9-cf86a8ec01a1__list_cycles
   teamId: beac9586-1f60-4eb1-82f5-3f12d028d1de
   ```
   This returns the current sprint (isCurrent: true) and previous sprint with their exact startsAt/endsAt dates. Use these as your sprint windows.

2. From the session list (Step 2), filter sessions to the current sprint window.

3. Classify each session as ticket or no-ticket using the rules above.

4. Pull current sprint issues from Linear using the MCP directly (NOT Zapier — Zapier can't filter by cycle):
   ```
   mcp__768703e1-6130-4d9e-bdc9-cf86a8ec01a1__list_issues
   team: beac9586-1f60-4eb1-82f5-3f12d028d1de
   cycle: <cycleId from step 1>
   limit: 50
   ```

5. Cross-reference: for each "ticket" session, is the work captured in an existing issue?
   - Sessions that cluster around the same theme count as one ticket (e.g., five onboarding sessions = one "Kai-first onboarding flow" ticket)
   - A session is covered if its core work appears in any existing issue's title or description
   - **Check previous sprints too** before creating new tickets — don't create duplicates for work that was already captured in a prior sprint

6. For any shipped work NOT in Linear, create the missing tickets via Zapier write action:
   - Group related sessions thematically (don't create one ticket per session)
   - Assign correct label: `build` (new feature), `Bug` (fix), `optimize` (improvement), `infra` (scripts/pipeline/tooling)
   - Assign to correct project: `Product` (user-facing) or `Pipeline` (scrapers, data, ATS)
   - Set state: Done in instructions (Zapier will guess the status_id correctly)
   - team_id: `beac9586-1f60-4eb1-82f5-3f12d028d1de`
   - **Before marking a ticket Done**, confirm with the user if you're unsure whether the feature is actually working — don't assume shipped = working

7. Report how many tickets were added.

**If Zapier auth times out on `updateIssue`**: flag the affected ticket(s) to the user and ask them to update manually in Linear. Do not retry in a loop.

## Step 3 — Pull Linear sprint data for both sprints

Use the Linear MCP (NOT Zapier) to pull issues for both the current and previous sprint:

```
mcp__768703e1-6130-4d9e-bdc9-cf86a8ec01a1__list_issues
cycle: <current sprint cycleId>   → current sprint

mcp__768703e1-6130-4d9e-bdc9-cf86a8ec01a1__list_issues
cycle: <previous sprint cycleId>  → last sprint
```

For each sprint, build a breakdown table:
- Columns = product areas with work (Jobs page, Kai, Auth/Onboarding, Landing page, Pipeline, Infra/Legal, etc.)
- Rows = labels (`build`, `Bug`, `optimize`, `infra`)
- Count Done tickets per cell

Show **both tables** — current sprint (in progress, label it as such) and previous sprint (completed).

Then compute a **balance check**: flag if `bug` or `infra` > `build` — recommend rebalancing next sprint.

## Step 4 — Pull pipeline health metrics from Supabase

Supabase project ID: `tdgptapfspleoobiyiqx`

Run these queries to get pipeline health numbers for the update:

```sql
-- New jobs pulled: this sprint vs last sprint
SELECT
  COUNT(*) FILTER (WHERE posted_at >= '<current sprint start>') AS new_jobs_this_sprint,
  COUNT(*) FILTER (WHERE posted_at >= '<prev sprint start>' AND posted_at < '<current sprint start>') AS new_jobs_last_sprint,
  COUNT(*) FILTER (WHERE is_active = true) AS total_active_jobs
FROM jobs;

-- Employer ATS coverage
SELECT
  COUNT(*) FILTER (WHERE verified_at >= '<current sprint start>') AS new_ats_this_sprint,
  COUNT(*) FILTER (WHERE verified_at >= '<prev sprint start>' AND verified_at < '<current sprint start>') AS new_ats_last_sprint,
  COUNT(*) AS total_ats_mapped
FROM employer_ats;

-- ATS breakdown by type
SELECT ats_type, COUNT(*) as count
FROM employer_ats
GROUP BY ats_type
ORDER BY count DESC;
```

**Column notes**: Use `posted_at` for job dates (not `first_seen_at` — that column does not exist). Use `verified_at` for employer ATS mapping dates.

Include a plain-English callout: what drove the biggest change in job count? What's the trajectory of employer ATS mapping (rate per day)?

## Step 5 — Draft the update (do NOT write to PROJECT.md yet)

Write the update using this exact format:

---

## Update as of [TODAY'S DATE]:

### 1. Done since last update ([LAST DATE] → [TODAY])

Group completed work by area. Be specific — name files, features, and fixes. Don't pad.

**Auth + onboarding**
- bullet per item

**Kai**
- bullet per item

**Jobs page**
- bullet per item

**Landing page**
- bullet per item

**Data pipeline**
- bullet per item

**Infrastructure / legal**
- bullet per item (include: X routines running, X skills active)

**Bug fixes**
- bullet per item

### 2. What we learned
- 3–5 honest observations — technical discoveries, UX insights, performance findings, surprises.
- State how many routines are running and how many skills are active.

### 3. Week [X] remaining — in order

| # | Task | Why it's next |
|---|---|---|
| 1 | Task name | One-line reason |
| 2 | Task name | One-line reason |

Pull remaining Week X tasks from the `### Week X` section of PROJECT.md. Order by impact × urgency. Be opinionated.

### 4. Sprint breakdown

**[Current sprint name] ([start] → [end]) — current, N shipped so far**

[table]

**[Previous sprint name] ([start] → [end]) — N shipped**

[table]

> Balance: [one-line observation + recommendation]

### 5. Pipeline health

| Metric | Last sprint | This sprint |
|---|---|---|
| New jobs pulled | N | N |
| Total active jobs | — | N |
| New employers ATS-mapped | N | N |
| Total employers confirmed ATS | — | N (breakdown by ATS type) |
| Employers in manual review queue | — | N |

[One-sentence callout on biggest change and trajectory]

### 6. The bottleneck

One short paragraph. Name the single thing blocking the most progress. Be direct.

### 7. Week [X] goal

One sentence. What does success look like this week?

---

## Step 6 — Show the draft and ask for approval

Present the full draft to the user. Ask: "Good to push this to the master plan?"

Do NOT modify PROJECT.md until the user confirms (yes / yep / looks good / go ahead / push it).

## Step 7 — Append to PROJECT.md (only after approval)

1. Grep for the most recent `## Update as of` line: `grep -n "## Update as of" /Users/dat/getdatjob/PROJECT.md | head -1`
2. Insert the new update block directly above that line, with a `---` separator between the new update and the old one.
3. Confirm: "Done — appended to PROJECT.md above the [date] update."
