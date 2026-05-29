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

export async function handleSearchJobs(input: SearchJobsInput) {
  const limit = Math.min(input.limit ?? 5, 10);
  const POSTED_DAYS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };

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

  // Department → title keyword list
  const titleKeywords: string[] | null = input.department
    ? (DEPT_KEYWORDS[input.department.toLowerCase()] ?? [input.department.toLowerCase()])
    : null;

  // Industry → company keyword list
  const companyKeywords: string[] | null = input.industry
    ? (INDUSTRY_COMPANY_KEYWORDS[input.industry.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? [input.industry.toLowerCase()])
    : null;

  // Location — "remote" stays as-is; everything else is passed through
  const location = input.location ? input.location.toLowerCase().trim() : null;

  // search_jobs_kai RPC deduplicates by company at the SQL level, so a single
  // bulk-posting employer (e.g. Lowe's 19K jobs, Amazon 10K jobs) can't crowd
  // out all other companies when we fetch the top-N.
  const { data, error } = await supabaseServer.rpc("search_jobs_kai", {
    p_cutoff:           cutoff,
    p_location:         location,
    p_query:            input.query?.trim() ?? null,
    p_title_keywords:   titleKeywords,
    p_company_keywords: companyKeywords,
    p_visa_tiers:       visaTiers,
    p_visa_class:       visaClass,
    p_salary_min:       input.salary_min ?? null,
    p_result_limit:     limit,
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
    visa_tier:      j.visa_tier,
    visa_class:     j.visa_class,
    salary_range:   j.salary_range ?? null,
    salary_estimate: j.salary_estimate ? Number(j.salary_estimate) : null,
    lca_count:      j.lca_count,
    lca_count_2025: j.lca_count_2025 ? Number(j.lca_count_2025) : null,
    lca_last_filed: j.lca_last_filed ?? null,
    ats_source:     j.ats_source ?? null,
    ats_job_id:     j.ats_job_id ?? null,
  }));

  return {
    count:            jobs.length,
    has_verified_jobs: jobs.some((j: any) => j.visa_tier === "verified"),
    jobs,
  };
}

export async function countMatchingJobs3d(params: {
  visa_category?: string;
  salary_min?: number;
  location?: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();

  let query = supabaseServer
    .from("jobs_kai_view")
    .select("*", { count: "exact", head: true })
    .gte("posted_at", cutoff);

  if (params.visa_category) {
    query = query.in("visa_tier", ["verified", "friendly"]);
  }
  if (params.salary_min && params.salary_min > 0) {
    query = query.gte("salary_estimate", params.salary_min);
  }
  if (params.location === "remote") {
    query = query.ilike("location", "%remote%");
  } else if (params.location) {
    query = query.ilike("location", `%${params.location}%`);
  }

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
