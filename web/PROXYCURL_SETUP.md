# LinkedIn Import via Proxycurl

How the URL → Kai context pipeline works, and what you need to set up.

## Flow

1. User pastes their LinkedIn URL into `<LinkedInImport />`.
2. Component POSTs to `/api/import-linkedin`.
3. Route auths the user via Supabase, calls `importLinkedInFromUrl()` in
   `src/lib/enrich-proxycurl.ts`.
4. Proxycurl returns full profile JSON (name, headline, summary, experiences,
   education, skills, location).
5. We upsert the scalar/array fields into `linkedin.profiles` and replace
   `public.user_work_history` rows for that user.
6. Kai's chat route (`/api/chat`) pulls headline + recent roles into the
   system prompt on every request via `buildUserContext()`.

## Setup steps

### 1. Sign up for Proxycurl

Create an account at https://nubela.co/proxycurl/ and buy credits. The
Person Profile endpoint costs 1 credit per fresh lookup (~$0.01) and the
client passes `use_cache=if-recent` which reuses recent crawls for free or
near-free on repeat imports.

### 2. Add env vars

Local — append to `web/.env.local`:

```
PROXYCURL_API_KEY=your_proxycurl_key_here
```

Prod — Vercel dashboard → Project → Settings → Environment Variables →
add `PROXYCURL_API_KEY` for Production (and Preview if you want it in
preview deploys).

### 3. Run the migration

```sql
-- web/supabase/migrations/20260527000001_proxycurl_columns.sql
-- Paste into Supabase Dashboard → SQL Editor → Run.
```

Adds `summary`, `location`, `skills`, `education`, `raw_proxycurl`, and
`proxycurl_imported_at` to `linkedin.profiles`.

### 4. Drop the component into onboarding

```tsx
import LinkedInImport from "@/app/components/LinkedInImport";

// Inside your onboarding step or settings page:
<LinkedInImport
  onImported={(preview) => {
    // navigate to next step, or refresh Kai's context
  }}
/>
```

Optional: pre-fill the input with whatever `linkedin.profiles.linkedin_url`
already has, so users who signed in with a vanity URL don't have to type:

```tsx
<LinkedInImport initialUrl={profile?.linkedin_url ?? ""} />
```

### 5. (Optional) Fire it automatically post-signup

In `src/app/auth/linkedin/callback/route.ts`, the `enrichUser()` call inside
`after()` already runs Apollo/PDL. To also run Proxycurl when we have a URL
from OAuth, add alongside it:

```ts
import { importLinkedInFromUrl } from "@/lib/enrich-proxycurl";

after(async () => {
  if (profile.linkedinUrl) {
    await importLinkedInFromUrl(userId, profile.linkedinUrl);
  }
  await enrichUser(/* ... */);
});
```

Only do this once you're comfortable with Proxycurl costs at signup volume.

## Error handling reference

| Status code | What it means | UI shows |
| --- | --- | --- |
| 400 | URL doesn't match LinkedIn pattern | "That doesn't look like a LinkedIn URL…" |
| 401 | User not signed in | "Unauthenticated" |
| 404 | Proxycurl couldn't find the profile | "Couldn't find that LinkedIn profile." |
| 429 | Rate limited | "Too many requests — try again in a minute." |
| 502 | Proxycurl errored, key missing, etc. | "Something went wrong…" — check logs |

## Risk notes

Proxycurl scrapes LinkedIn. LinkedIn's ToS technically prohibits this, and
they've gone after scrapers before (hiQ Labs et al). Proxycurl itself argues
they only ingest public profile data and have won similar fights, but the
legal posture isn't settled. Use with eyes open. If you ever get a
cease-and-desist from LinkedIn, the fallback is the "paste profile text"
flow we discussed.
