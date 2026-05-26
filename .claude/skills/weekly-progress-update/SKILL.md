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
- Data pipeline (scrapers, ATS detection, Supabase)
- Jobs page (UI, filters, cards, performance)
- Landing page (design, copy, mobile, A/B tests)
- Infrastructure (deploy, cron, domain, env)
- Bug fixes
- Non-getdatjob sessions → exclude

Also check:
- `mcp__scheduled-tasks__list_scheduled_tasks` — how many routines are active, when they last ran
- `ls /Users/dat/getdatjob/scrapers/` and `ls /Users/dat/getdatjob/web/src/app/components/` — new files as proof of work
- The available skills list in the system prompt — note any new skills created since the last update

## Step 2.5 — Sprint ticket audit (session → Linear reconciliation)

Before pulling sprint data, verify that all shipped work has a Linear ticket.

**Rules for what counts as a ticket:**
- ✅ **Ticket**: session where something shipped or was fixed — bug fix, feature built, scraper/script deployed, optimization landed, tool created
- ❌ **No ticket**: automated crons ("Getdatjob daily pull", any scheduled routine), brainstorm/discussion/planning sessions (title contains "brainstorm", "strategy", "aspirations", "analysis", "research", "overview", "plan", "notes", "replica", "inventory", "options", "discussion"), competitor/reference research

**How to audit:**
1. Identify the current sprint's date window (Monday → Sunday, or the cycle start/end dates from Linear)
2. From the session list (Step 2), filter to the sprint window
3. Classify each session as ticket or no-ticket using the rules above
4. Pull current sprint issues from Linear: `mcp__768703e1-*__list_issues` with `cycle: "Sprint N"`
5. Cross-reference: for each "ticket" session, is the work captured in an existing issue?
   - Sessions that cluster around the same theme count as one ticket (e.g., five logo bug sessions = one "logo bugs" ticket)
   - A session is covered if its core work appears in any existing issue's title or description
6. For any shipped work NOT in Linear, create the missing tickets:
   - Group related sessions thematically (don't create one ticket per session)
   - Assign correct label: `build` (new feature), `Bug` (fix), `optimize` (improvement), `infra` (scripts/pipeline/tooling)
   - Assign to the correct project: `Product` (user-facing) or `Pipeline` (scrapers, data, ATS)
   - Set state: `Done`, cycle: current sprint
7. Report how many tickets were added

## Step 3 — Pull Linear sprint data

Use the Zapier MCP to query Linear for the current sprint's issues:
```
execute_zapier_read_action — Linear: Find Issues (filter: current sprint / current cycle)
```

From the results, build a sprint summary table. Columns = product areas (Jobs page, Kai, Pipeline, etc. — use whatever areas had work). Rows = labels (`build`, `bug`, `optimize`, `infra`). Count closed tickets per cell.

Example:
| | Jobs page | Kai | Paywall | Pipeline |
|---|---|---|---|---|
| `build` | 0 | 1 | 1 | 0 |
| `bug` | 2 | 0 | 0 | 1 |
| `optimize` | 0 | 0 | 0 | 2 |
| `infra` | 0 | 0 | 0 | 1 |

Then compute a **balance check**: which label had the most tickets? Flag if `bug` or `infra` > `build` — recommend rebalancing next sprint.

If Linear is not yet set up or Zapier is not authenticated, note "Linear not connected — skipping sprint data" and continue.

## Step 4 — Draft the update (do NOT write to PROJECT.md yet)

Write the update using this exact format:

---

## Update as of [TODAY'S DATE]:

### 1. Done since last update ([LAST DATE] → [TODAY])

Group completed work by area. Be specific — name files, features, and fixes. Don't pad.

**Data pipeline**
- bullet per item

**Jobs page**
- bullet per item

**Landing page**
- bullet per item

**Infrastructure**
- bullet per item (include: X routines running, X skills active)

### 2. What we learned
- 3–5 honest observations — technical discoveries, UX insights, performance findings, surprises.
- State how many new skills were created (for getdatjob specifically) and how many scheduled routines are active.

### 3. Week [X] remaining — in order

| # | Task | Why it's next |
|---|---|---|
| 1 | Task name | One-line reason |
| 2 | Task name | One-line reason |

Pull remaining Week X tasks from the `### Week X` section of PROJECT.md. Order by impact × urgency. Be opinionated.

### 4. Sprint breakdown

Paste the table from Step 3 here. Add a one-line balance check below it.

> Balance: Heavy on `bug` this sprint — prioritize `build` next sprint.

(If Linear not connected, omit this section.)

### 5. The bottleneck

One short paragraph. Name the single thing blocking the most progress. Be direct.

### 6. Week [X+1] goal

One sentence. What does success look like next week?

---

## Step 5 — Show the draft and ask for approval

Present the full draft to the user. Ask: "Good to push this to the master plan?"

Do NOT modify PROJECT.md until the user confirms (yes / yep / looks good / go ahead / push it).

## Step 6 — Append to PROJECT.md (only after approval)

Find the line `## Update as of 5/21:` (the current most recent update). Insert the new update block directly above it, with a `---` separator between them.

Confirm: "Done — appended to PROJECT.md above the previous update."
