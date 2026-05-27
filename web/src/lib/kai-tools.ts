import { createClient } from "@supabase/supabase-js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

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
            'Location filter — "remote", a US city name (e.g. "San Francisco"), or a state abbreviation (e.g. "CA")',
        },
        department: {
          type: "string",
          description:
            'Job function — e.g. "Product", "Engineering", "Data", "Design", "Sales", "Marketing", "Finance"',
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
  department?: string;
  industry?: string;
  salary_min?: number;
  visa_category?: string;
  posted_within?: "1d" | "3d" | "7d" | "30d";
  limit?: number;
};

const DEPT_KEYWORDS: Record<string, string[]> = {
  product:     ["product manager", "product owner", "pm ", " pm,", "head of product"],
  engineering: ["engineer", "developer", "swe", "software", "backend", "frontend", "full stack", "devops", "platform", "infrastructure", "sre"],
  data:        ["data scientist", "data engineer", "data analyst", "ml engineer", "machine learning", "analytics"],
  design:      ["designer", "ux", "ui ", "product design"],
  sales:       ["sales", "account executive", "account manager", "business development", "revenue"],
  marketing:   ["marketing", "growth", "seo", "content", "brand"],
  finance:     ["finance", "financial", "accounting", "accountant", "controller", "cfo"],
  security:    ["security", "infosec", "cybersecurity", "soc "],
};

export async function handleSearchJobs(input: SearchJobsInput) {
  const limit = Math.min(input.limit ?? 5, 10);
  const POSTED_DAYS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };

  let q = supabaseServer.from("jobs_kai_view").select("*");

  // Date filter — default to 3d if not specified
  const postedWithin = input.posted_within ?? "3d";
  const days = POSTED_DAYS[postedWithin];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  q = q.gte("posted_at", cutoff);

  // Visa category
  if (input.visa_category) {
    const v = input.visa_category.toUpperCase();
    if (v === "H-1B" || v === "H1B") {
      q = q.in("visa_tier", ["verified", "friendly"]);
    } else {
      q = q.ilike("visa_class", `%${input.visa_category}%`);
    }
  }

  // Salary filter (against estimate)
  if (input.salary_min) {
    q = q.gte("salary_estimate", input.salary_min);
  }

  // Location
  if (input.location) {
    const loc = input.location.toLowerCase().trim();
    if (loc === "remote") {
      q = q.ilike("location", "%remote%");
    } else {
      q = q.ilike("location", `%${loc}%`);
    }
  }

  // Free-text keyword — title or company
  if (input.query) {
    const safe = input.query.trim().replace(/[%_]/g, "\\$&");
    q = q.or(`title.ilike.%${safe}%,company.ilike.%${safe}%`);
  }

  // Department — keyword match on title
  if (input.department) {
    const deptKey = input.department.toLowerCase();
    const keywords = DEPT_KEYWORDS[deptKey] ?? [deptKey];
    const orClause = keywords.map((k) => `title.ilike.%${k}%`).join(",");
    q = q.or(orClause);
  }

  // Industry — keyword match on company (best effort without industry column)
  // For now skip — industry data not in jobs_kai_view

  // Fetch a large window so one prolific employer can't crowd out all others.
  // (e.g. a single company posting 200 jobs would exhaust limit*4=24 rows.)
  q = q
    .order("posted_at", { ascending: false, nullsFirst: false })
    .limit(1000);

  const { data, error } = await q;
  if (error) return { error: error.message, jobs: [] };

  const tierRank = (tier: string) => (tier === "verified" ? 0 : 1);
  const allSorted = (data ?? [])
    .sort((a: any, b: any) => {
      const tierDiff = tierRank(a.visa_tier) - tierRank(b.visa_tier);
      if (tierDiff !== 0) return tierDiff;
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime();
    });

  // One job per company — keeps results visually diverse
  const seenCompanies = new Set<string>();
  const sorted: typeof allSorted = [];
  for (const job of allSorted) {
    const key = (job.company as string).toLowerCase().trim();
    if (!seenCompanies.has(key)) {
      seenCompanies.add(key);
      sorted.push(job);
      if (sorted.length >= limit) break;
    }
  }

  const hasVerifiedJobs = sorted.some((j: any) => j.visa_tier === "verified");

  return {
    count: sorted.length,
    has_verified_jobs: hasVerifiedJobs,
    jobs: sorted.map((j: any) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      company_domain: j.company_domain,
      location: j.location,
      url: j.url,
      posted_at: j.posted_at,
      visa_tier: j.visa_tier,
      visa_class: j.visa_class,
      salary_estimate: j.salary_estimate ? Number(j.salary_estimate) : null,
      lca_count: j.lca_count,
      lca_count_2025: j.lca_count_2025 ? Number(j.lca_count_2025) : null,
      lca_last_filed: j.lca_last_filed ?? null,
      ats_source: j.ats_source ?? null,
      ats_job_id: j.ats_job_id ?? null,
    })),
  };
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
