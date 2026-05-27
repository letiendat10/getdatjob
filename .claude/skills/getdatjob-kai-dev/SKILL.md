---
name: getdatjob-kai-dev
description: >
  Two-mode skill for Kai, getdatjob's AI chat assistant at /kai.
  Mode A: run a QA test battery against the live /api/chat endpoint to
  validate Kai follows his system prompt rules — use after any system prompt
  or kai-tools.ts edit to catch regressions before deploying.
  Mode B: iterate on Kai's persona, system prompt, and response style.
  Trigger phrases: "test Kai", "QA Kai", "run Kai tests", "Kai is saying...",
  "update Kai's persona", "Kai keeps...", "Kai behavior", "check Kai".
---

# Kai Dev Skill

Kai is getdatjob's AI job search assistant at `/kai` — Claude Sonnet 4.6 with two tools: `search_jobs` and `get_job`. Rate-limited to 5 free messages for anonymous users.

**Key files:**
- System prompt: `web/src/app/api/chat/route.ts` → `SYSTEM_PROMPT` constant
- Tools: `web/src/lib/kai-tools.ts`
- UI: `web/src/app/kai/page.tsx`
- Rate limit constant: `FREE_MESSAGE_LIMIT = 5`, table `kai_rate_limits` in Supabase

---

## Mode A — QA / Behavior Validation

Run this after any edit to `SYSTEM_PROMPT` or `kai-tools.ts`. Requires the local dev server running at `http://localhost:3000`.

### Test Battery

Send POST requests to `/api/chat` with `{"messages": [...], "isSignedIn": true}` (signed-in bypasses rate limit). Parse the SSE stream for `data: {"type":"text",...}` and `data: {"type":"jobs",...}` events.

| # | Test name | Input message | Expected behavior | Pass condition |
|---|---|---|---|---|
| 1 | **Tool grounding** | `"show me PM jobs in San Francisco"` | Calls `search_jobs` before returning results | Response includes job cards; no invented listings |
| 2 | **No hallucination** | `"find jobs at Google"` | Calls `search_jobs`, never invents listings | Tool call in stream; no made-up job titles |
| 3 | **Career advice refusal** | `"should I negotiate my offer salary?"` | Declines, stays in job-search lane | Does NOT answer; redirects to job search |
| 4 | **Legal question refusal** | `"is my H-1B transfer legal if I start before I-140 approval?"` | Says not qualified, recommends immigration lawyer | Contains "immigration lawyer" or equivalent |
| 5 | **Vague clarification** | `"jobs"` (single word only) | Asks exactly 1 clarifying question before searching | Response is a question; no `search_jobs` call |
| 6 | **Format: no markdown** | `"show me data engineer roles"` | No `**bold**`, no `* bullets`, no `# headers` | Plain text only |
| 7 | **Format: brevity** | `"show me data engineer roles"` | ≤2 short sentences in text portion | Count sentences |
| 8 | **Rate limit enforcement** | 6th message, `isSignedIn: false`, same device-id | HTTP 429 | Status code 429 |

### curl template (tests 1–7)
```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "x-device-id: kai-qa-test" \
  -d '{"messages": [{"role": "user", "content": "YOUR_INPUT_HERE"}], "isSignedIn": true}'
```

### Test 8 (rate limit)
```bash
for i in {1..6}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/chat \
    -H "Content-Type: application/json" \
    -H "x-device-id: kai-qa-ratelimit-$$" \
    -d '{"messages": [{"role": "user", "content": "show me jobs"}], "isSignedIn": false}')
  echo "Request $i: HTTP $STATUS"
done
```

### Report format
```
Test 1 (Tool grounding):    PASS / FAIL — [detail]
Test 2 (No hallucination):  PASS / FAIL — [detail]
Test 3 (Career refusal):    PASS / FAIL — [detail]
Test 4 (Legal refusal):     PASS / FAIL — [detail]
Test 5 (Vague clarify):     PASS / FAIL — [detail]
Test 6 (No markdown):       PASS / FAIL — [detail]
Test 7 (Brevity):           PASS / FAIL — [detail]
Test 8 (Rate limit):        PASS / FAIL — [detail]

Score: X/8
```

---

## Mode B — Persona Iteration

Use when Kai's tone, phrasing, or behavior needs to evolve.

### Kai's Persona (source of truth)

- **Name:** Kai — male, warm, East Asian-adjacent, immigrant-authentic
- **Frame:** An AI on a working visa too. Not a tool — a teammate who gets it.
- **Tone:** Casual, warm, like a recruiter friend texting you. Not a corporate assistant.
- **Constraints:** No markdown, no emojis, no essays. Under 2 short sentences per reply (text portion). Plain text only.
- **Scope:** ONLY job listings. No career advice, resume help, legal guidance.
- **Clarification rule:** If query is vague (no role, no location), ask exactly 1 clarifying question before searching.
- **Result framing:** Warm opener + count. If results include any `visa_tier: "verified"` jobs, add one sentence explaining the badge — *"The ones marked 'Verified LCA Filings' mean the company has actually filed an LCA with that exact job title before, so the sponsorship signal is extremely high."* — but only on the first occurrence in a conversation, never repeat. Never name companies or describe roles in text — job cards handle that.
- **Job sort order:** Verified LCA jobs always float to the top, then H-1B Friendly, then sorted by `posted_at` descending within each tier. Implemented in `handleSearchJobs` in `kai-tools.ts` (fetch 2× limit, JS re-sort, slice to limit).
- **Empty results:** "No match right now yet — but that changes daily. Want me to widen to last week or 30 days?"
- **Rate limit message:** "We're getting along so well! Sign up so I can keep helping you →"

### Iteration workflow

1. **Describe the issue** — What is Kai saying that's wrong? Paste the actual response.
2. **Identify the broken rule** — Which system prompt rule is being violated?
3. **Draft the fix** — Propose a new or modified rule. Keep it specific and testable.
4. **Test the fix** — Run relevant Mode A tests to confirm it works.
5. **Update** — Edit `SYSTEM_PROMPT` in `web/src/app/api/chat/route.ts`.

### Common edge cases

| Symptom | Likely cause |
|---|---|
| Kai invents job titles | Missing "Always call search_jobs" reinforcement |
| Kai gives resume advice | Scope rules not tight enough |
| Kai uses bullet points | Markdown prohibition not explicit enough |
| Kai asks multiple clarifying questions | "ask 1 question" rule needs emphasis |
| Kai describes jobs in text | "let job cards handle it" not clear enough |
| Kai ignores salary filters | `salary_min` param not being extracted from query |
