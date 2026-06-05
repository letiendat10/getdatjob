import { createClient } from "@supabase/supabase-js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { toCanonicalDepartments, toCanonicalLevel } from "@/lib/taxonomy";

const supabaseServer = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Tool definitions sent to Claude ──────────────────────────────────────────

export const KAI_TOOLS: Tool[] = [
  {
    name: "search_jobs",
    description:
      "Search verified visa-sponsoring job listings. Call this whenever the user asks to find, show, filter, or browse jobs. Always call this before returning any job results — never invent listings.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Free-text keyword — job title, skill, or company name",
        },
        location: {
          type: "string",
          description:
            'Location filter — "remote" for remote jobs, a US city name (e.g. "San Francisco"), or a US state abbreviation (e.g. "CA"). OMIT this parameter entirely (do not pass it) when the user is open to any location, nationwide, or "anywhere".',
        },
        department: {
          type: "string",
          description:
            'Job function — e.g. "Product", "Engineering", "Data", "Design", "Sales", "Marketing", "Finance", "Security"',
        },
        level: {
          type: "string",
          enum: ["Entry/Junior", "Senior", "Principal / Staff", "Lead/Manager", "Director", "VP"],
          description:
            "Seniority level. Use the closest bucket: Entry/Junior (entry, associate, new grad), Senior, Principal / Staff (principal, staff, distinguished, fellow), Lead/Manager (team lead or people manager), Director, VP (VP and above).",
        },
        industry: {
          type: "string",
          description:
            'Company industry — e.g. "Fintech", "Healthcare", "AI/ML", "SaaS", "E-commerce"',
        },
        salary_min: {
          type: "number",
          description: "Minimum annual salary in USD",
        },
        visa_category: {
          type: "string",
          description: 'Visa type — "H-1B", "E-3", "TN", or "OPT"',
        },
        posted_within: {
          type: "string",
          enum: ["1d", "3d", "7d", "30d"],
          description: "Only show jobs posted within this window",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 5, max 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_job",
    description: "Get full details for a specific job by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "The job ID" },
      },
      required: ["id"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

type SearchJobsInput = {
  query?: string;
  location?: string;
  location_tokens?: string[]; // metro / multi-city OR-match; takes precedence over `location`
  department?: string;
  level?: string;
  industry?: string;
  salary_min?: number;
  visa_category?: string;
  posted_within?: "1d" | "3d" | "7d" | "14d" | "30d";
  limit?: number;
};

// Department & level are real, classified columns on `jobs` — translated from user-facing
// labels to the canonical stored values via @/lib/taxonomy (single source of truth).

// Industry → company name keyword map.
// Normalized key = input.industry lowercased, non-alphanumeric stripped
// (e.g. "Healthcare" → "healthcare", "AI/ML" → "aiml", "E-commerce" → "ecommerce")
const INDUSTRY_COMPANY_KEYWORDS: Record<string, string[]> = {
  healthcare:  ["health", "hospital", "medical", "clinic", "care", "pharma",
                "surgical", "rehab", "dental", "optum", "cigna", "anthem",
                "humana", "aetna", "kaiser", "cvs", "walgreen"],
  fintech:     ["financial", "finance", "bank", "capital", "payment", "credit",
                "lending", "invest", "wealth", "trading", "insurance", "mortgage"],
  aiml:        ["intelligence", "neural", "cognitive", "deepmind", "openai"],
  saas:        ["software", "cloud", "solutions"],
  ecommerce:   ["commerce", "retail", "marketplace", "shopify"],
  govtech:     ["government", "federal", "defense", "aerospace", "lockheed",
                "raytheon", "booz", "leidos", "saic", "caci"],
  edtech:      ["education", "learning", "school", "university", "academy", "tutoring"],
};

// Metro → the messy free-text city fragments that should all count as "in this metro".
// Used by the onboarding cascade (api/onboarding/jobs/route.ts) and the search/count
// helpers below. Lowercase; each token is matched as ILIKE '%token%' against jobs.location.
export const METRO_TOKENS: Record<string, { display: string; tokens: string[] }> = {
  bay_area: {
    display: "the Bay Area",
    tokens: ["san francisco", "south san francisco", "oakland", "san jose", "palo alto",
             "mountain view", "sunnyvale", "menlo park", "berkeley", "redwood city",
             "santa clara", "cupertino", "foster city", "san mateo", "bay area"],
  },
  nyc: {
    display: "the NYC area",
    tokens: ["new york", "nyc", "brooklyn", "manhattan", "jersey city", "newark", "hoboken"],
  },
};

// Strip characters that would break a PostgREST `.or()` filter string or an ILIKE pattern,
// so a city token can never inject extra conditions or wildcards.
export function escapeIlike(s: string): string {
  return s.replace(/[%,()*]/g, " ").trim();
}

export async function handleSearchJobs(input: SearchJobsInput) {
  const limit = Math.min(input.limit ?? 5, 25);
  const POSTED_DAYS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 };

  const postedWithin = input.posted_within ?? "7d";
  const days = POSTED_DAYS[postedWithin];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // Visa filters — visa_class is not populated in jobs_kai_view so all visa
  // types fall back to the verified/friendly tier (H-1B sponsors also
  // sponsor E-3/TN/OPT in practice).
  let visaTiers: string[] | null = null;
  const visaClass: string | null = null;
  if (input.visa_category) {
    visaTiers = ["verified", "friendly"];
  }

  // Department & level → canonical stored columns (filtered via p_departments / p_level).
  // A single UX bucket can map to several departments (e.g. "Data / AI" → Data + AI/ML).
  const departments = toCanonicalDepartments(input.department);
  const level = toCanonicalLevel(input.level);

  // Industry → company keyword list
  const companyKeywords: string[] | null = input.industry
    ? (INDUSTRY_COMPANY_KEYWORDS[input.industry.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? [input.industry.toLowerCase()])
    : null;

  // Location — "remote" routes to the is_remote flag; "anywhere" phrases → no filter.
  // location_tokens (metro / multi-city) take precedence; else a single best-effort token.
  const rawLocation = input.location ? input.location.toLowerCase().trim() : null;
  const ANYWHERE_PHRASES = ["anywhere", "us", "usa", "united states", "united states of america", "nationwide", "open anywhere", "anywhere in the us", "anywhere in the usa"];
  const remote = rawLocation === "remote" ? true : null;
  const singleLocation = remote ? null : (rawLocation && !ANYWHERE_PHRASES.includes(rawLocation) ? rawLocation : null);
  const locationTokens = input.location_tokens?.length
    ? input.location_tokens.map((t) => t.toLowerCase().trim()).filter(Boolean)
    : (singleLocation ? [singleLocation] : null);

  // search_jobs_kai RPC deduplicates by company at the SQL level, so a single
  // bulk-posting employer (e.g. Lowe's 19K jobs, Amazon 10K jobs) can't crowd
  // out all other companies when we fetch the top-N.
  const { data, error } = await supabaseServer.rpc("search_jobs_kai", {
    p_cutoff:           cutoff,
    p_location:         null,
    p_location_tokens:  locationTokens,
    p_query:            input.query?.trim() ?? null,
    p_title_keywords:   null,
    p_company_keywords: companyKeywords,
    p_visa_tiers:       visaTiers,
    p_visa_class:       visaClass,
    p_salary_min:       input.salary_min ?? null,
    p_result_limit:     limit,
    // departments is [] for a live bucket outside the canonical 15 (e.g. an LLM-coined
    // "Healthcare"); fall back to the literal value so it filters instead of being dropped.
    p_departments:      departments.length ? departments : (input.department ? [input.department] : null),
    p_level:            level,
    p_remote:           remote,
  });

  if (error) return { error: error.message, jobs: [] };

  const jobs = (data ?? []).map((j: any) => ({
    id:             j.id,
    title:          j.title,
    company:        j.company,
    company_domain: j.company_domain,
    location:       j.location,
    url:            j.url,
    posted_at:      j.posted_at,
    // Honest freshness: real posted_at when known, else first-seen (scraped_at).
    effective_posted_at: j.effective_posted_at ?? j.posted_at ?? null,
    department:     j.department ?? null,
    job_level:      j.job_level ?? null,
    is_remote:      j.is_remote ?? null,
    visa_tier:      j.visa_tier,
    visa_class:     j.visa_class,
    salary_range:   j.salary_range ?? null,
    salary_min_num: j.salary_min_num ?? null,
    salary_max_num: j.salary_max_num ?? null,
    salary_period:  j.salary_period ?? null,
    lca_count:      j.lca_count,
    lca_count_2025: j.lca_count_2025 ? Number(j.lca_count_2025) : null,
    lca_last_filed: j.lca_last_filed ?? null,
    e3_lca_count:   j.e3_lca_count ? Number(j.e3_lca_count) : null,
    ats_source:     j.ats_source ?? null,
    ats_job_id:     j.ats_job_id ?? null,
    poc_first_name: j.poc_first_name ?? null,
    poc_last_name:  j.poc_last_name ?? null,
    poc_email:      j.poc_email ?? null,
  }));

  return {
    count:            jobs.length,
    has_verified_jobs: jobs.some((j: any) => j.visa_tier === "verified"),
    jobs,
  };
}

export async function countMatchingJobsInWindow(params: {
  visa_category?: string;
  salary_min?: number;
  remote?: boolean;            // true → is_remote filter
  locationTokens?: string[];   // OR-match of ILIKE city fragments (metro / single city)
  department?: string;
  level?: string;  // "senior_ic" | "manager" | "either"
  days: number;
}): Promise<number> {
  const cutoff = new Date(Date.now() - params.days * 86_400_000).toISOString();

  let query = supabaseServer
    .from("jobs_kai_view")
    .select("*", { count: "exact", head: true })
    .gte("effective_posted_at", cutoff);

  if (params.visa_category) {
    query = query.in("visa_tier", ["verified", "friendly"]);
  }
  // Min-salary: real parsed salary only, keep unknowns visible (mirrors the RPC).
  if (params.salary_min && params.salary_min > 0) {
    query = query.or(`salary_max_num.gte.${params.salary_min},salary_max_num.is.null`);
  }
  if (params.remote) {
    query = query.eq("is_remote", true);
  } else if (params.locationTokens?.length) {
    // OR of ILIKE fragments so a metro (or single city) matches the messy free-text
    // location column. escapeIlike keeps a token from breaking the PostgREST or() string.
    query = query.or(params.locationTokens.map((t) => `location.ilike.%${escapeIlike(t)}%`).join(","));
  }

  // Department & level — match the canonical stored columns (mirrors the RPC's ANY / =).
  const departments = toCanonicalDepartments(params.department);
  if (departments.length) query = query.in("department", departments);

  const level = toCanonicalLevel(params.level);
  if (level) query = query.eq("job_level", level);

  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

export async function handleGetJob(input: { id: number }) {
  const { data, error } = await supabaseServer
    .from("jobs_kai_view")
    .select("*")
    .eq("id", input.id)
    .single();

  if (error) return { error: error.message };
  return data;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

export const FREE_MESSAGE_LIMIT = 5;

export async function checkAndIncrementRateLimit(
  fingerprint: string
): Promise<{ allowed: boolean; count: number }> {
  const { data, error } = await supabaseServer
    .from("kai_rate_limits")
    .select("message_count")
    .eq("fingerprint", fingerprint)
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no row found — treat as new user
    return { allowed: true, count: 0 };
  }

  const current = data?.message_count ?? 0;

  if (current >= FREE_MESSAGE_LIMIT) {
    return { allowed: false, count: current };
  }

  // Upsert — increment count
  await supabaseServer.from("kai_rate_limits").upsert(
    {
      fingerprint,
      message_count: current + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "fingerprint" }
  );

  return { allowed: true, count: current + 1 };
}
