// Person enrichment pipeline: PDL first, Apollo.io fallback.
// Called async via after() in auth/callback — fires after the redirect.
// Writes to enriched.profiles via enrich_set_result / enrich_set_failed RPCs.
//
// Env vars:
//   PDL_API_KEY    — People Data Labs (https://www.peopledatalabs.com)
//   APOLLO_API_KEY — Apollo.io (https://www.apollo.io)

import { createSupabaseAdmin } from "./supabase-admin";

const PDL_URL    = "https://api.peopledatalabs.com/v5/person/enrich";
const APOLLO_URL = "https://api.apollo.io/api/v1/people/match";

// ── Shared mappings ───────────────────────────────────────────────────────────

const FUNCTION_MAP: Record<string, string> = {
  engineering:          "Engineering",
  software:             "Engineering",
  it:                   "Engineering",
  product:              "Product",
  design:               "Design",
  "data science":       "Data",
  analytics:            "Data",
  research:             "Data",
  sales:                "Sales",
  "business development": "Sales",
  marketing:            "Marketing",
  finance:              "Finance",
  accounting:           "Finance",
  operations:           "Operations",
  "human resources":    "Operations",
  hr:                   "Operations",
  legal:                "Other",
  education:            "Other",
};

const MANAGER_LEVELS = new Set([
  "manager", "director", "vp", "c_suite", "cxo", "owner", "partner",
]);

type EnrichResult = {
  p_location:      string | null;
  p_current_title: string | null;
  p_job_function:  string;
  p_job_level:     "IC" | "Manager";
};

// ── PDL ───────────────────────────────────────────────────────────────────────

async function tryPDL(
  linkedinUrl: string | null,
  email:       string | null,
  firstName:   string | null,
  lastName:    string | null,
): Promise<EnrichResult | null> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({ min_likelihood: "6" });

  // LinkedIn URL gives ~88% match rate vs ~55% for email+name
  if (linkedinUrl) {
    params.set("profile", linkedinUrl.replace("https://www.", "").replace("https://", ""));
  } else {
    if (email)     params.set("email",      email);
    if (firstName) params.set("first_name", firstName);
    if (lastName)  params.set("last_name",  lastName);
  }

  try {
    const res = await fetch(`${PDL_URL}?${params}`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      console.error(`[pdl] API ${res.status}: ${body.slice(0, 500)}`);
      return null;
    }

    const data = await res.json() as {
      data?: {
        job_title?:        string;
        job_title_role?:   string;
        job_title_levels?: string[];
        location_name?:    string;
        location_locality?: string;
        location_region?:  string;
      };
    };

    const p = data.data;
    if (!p) return null;

    const location =
      p.location_name ??
      (p.location_locality && p.location_region
        ? `${p.location_locality}, ${p.location_region}`
        : p.location_locality ?? null);

    const role   = (p.job_title_role ?? "").toLowerCase();
    const levels = Array.isArray(p.job_title_levels) ? p.job_title_levels : [];

    console.log(`[pdl] matched`, { title: p.job_title, location });

    return {
      p_location:      location,
      p_current_title: p.job_title ?? null,
      p_job_function:  FUNCTION_MAP[role] ?? "Other",
      p_job_level:     levels.some(l => MANAGER_LEVELS.has(l.toLowerCase())) ? "Manager" : "IC",
    };
  } catch (err) {
    console.error("[pdl] fetch error:", err);
    return null;
  }
}

// ── Apollo.io ─────────────────────────────────────────────────────────────────

async function tryApollo(
  linkedinUrl: string | null,
  email:       string | null,
  firstName:   string | null,
  lastName:    string | null,
): Promise<EnrichResult | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(APOLLO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        linkedin_url:            linkedinUrl,
        email,
        first_name:              firstName,
        last_name:               lastName,
        reveal_personal_emails:  false,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[apollo] API ${res.status}: ${body.slice(0, 500)}`);
      return null;
    }

    const { person } = await res.json() as {
      person?: {
        title?:       string;
        city?:        string;
        state?:       string;
        seniority?:   string;
        departments?: string[];
      };
    };

    if (!person) return null;

    const location =
      person.city && person.state ? `${person.city}, ${person.state}` :
      person.city ?? null;

    const dept     = (person.departments?.[0] ?? "").toLowerCase();
    const seniority = (person.seniority ?? "").toLowerCase();

    console.log(`[apollo] matched`, { title: person.title, location });

    return {
      p_location:      location,
      p_current_title: person.title ?? null,
      p_job_function:  FUNCTION_MAP[dept] ?? "Other",
      p_job_level:     MANAGER_LEVELS.has(seniority) ? "Manager" : "IC",
    };
  } catch (err) {
    console.error("[apollo] fetch error:", err);
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function enrichUser(
  userId:      string,
  email:       string | null,
  firstName:   string | null,
  lastName:    string | null,
  linkedinUrl: string | null,
): Promise<void> {
  const supabase = createSupabaseAdmin();

  const result =
    (await tryPDL(linkedinUrl, email, firstName, lastName)) ??
    (await tryApollo(linkedinUrl, email, firstName, lastName));

  if (result) {
    const { error } = await supabase.rpc("enrich_set_result", {
      p_user_id: userId,
      ...result,
    });
    if (error) console.error("[enrich] enrich_set_result RPC error:", error);
    return;
  }

  console.warn(`[enrich] ${userId} — both PDL and Apollo failed, marking failed`);
  const { error } = await supabase.rpc("enrich_set_failed", { p_user_id: userId });
  if (error) console.error("[enrich] enrich_set_failed RPC error:", error);
}
