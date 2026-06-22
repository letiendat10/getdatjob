import { createClient } from "@supabase/supabase-js";
import { toStoredDepartments } from "@/lib/taxonomy";

export const PAGE_SIZE = 30;

const POSTED_DAYS: Record<string, number> = { "1d": 1, "2d": 2, "3d": 3, "7d": 7, "30d": 30, "90d": 90 };

const LOC_PATTERNS: Record<string, string[]> = {
  "Remote":                  ["remote"],
  "San Francisco Bay Area":  ["san francisco", "palo alto", "menlo park", "mountain view", "sunnyvale", "south san francisco", "redwood city", "bay area", "ca -", "california"],
  "New York City":           ["new york", "brooklyn", "manhattan", "nyc"],
  "Seattle, WA":             ["seattle", "washington"],
  "Chicago, IL":             ["chicago", "illinois"],
  "Los Angeles, CA":         ["los angeles", "santa monica", "culver city"],
  "Austin, TX":              ["austin", "texas"],
  "Boston, MA":              ["boston", "massachusetts"],
  "Denver, CO":              ["denver", "colorado"],
  "Washington, DC":          ["washington dc", "arlington va"],
  "Atlanta, GA":             ["atlanta", "georgia"],
  "Miami, FL":               ["miami", "florida"],
  "Nashville, TN":           ["nashville", "tennessee"],
  "Portland, OR":            ["portland", "oregon"],
  "Salt Lake City, UT":      ["salt lake", "utah"],
  "Phoenix, AZ":             ["phoenix", "scottsdale", "tempe", "arizona"],
  "San Diego, CA":           ["san diego"],
  "Virginia":                ["mclean", "reston", "virginia"],
  "Pennsylvania":            ["pittsburgh", "philadelphia", "pennsylvania"],
};

const VISA_PATTERNS: Record<string, string> = {
  "H1B": "H-1B",
  "E3":  "E-3",
  "TN":  "TN",
};

// Department/level filtering is now server-side equality on the stored canonical
// jobs.department / jobs.job_level columns (classify.py is the single source of
// truth) — see queryJobs below. The old title-ILIKE keyword maps were removed.

// P1: Lean type — only fields actually rendered in the UI.
// Fields removed: employer_id, lca_count (base), title_clean,
//                 title_employer_lca_count, no_sponsor_in_desc_flag
// visa_types kept in the DB view (used in WHERE filter) but excluded from type.
export type JobRow = {
  id:                number;
  title:             string;
  location:          string;
  url:               string;
  posted_at:         string | null;
  effective_posted_at: string | null;
  ats_source:        string;
  ats_job_id:        string;
  ats_slug:          string | null;
  company:           string;
  company_domain_url: string | null;
  lca_count_2025:    number;
  last_filing_date:  string | null;
  confidence_tier:   string | null;
  is_active:         boolean;
  is_remote:         boolean | null;
  salary_range:      string | null;
  e3_lca_count:      number | null;
  department:        string | null;
  job_level:         string | null;
  poc_first_name:    string | null;
  poc_last_name:     string | null;
  poc_email:         string | null;
};

export async function queryJobs(params: {
  q: string; location: string; company: string;
  posted: string; sort: string; page: number;
  signal: string; visa: string;
  department: string; level: string;         // P3
  salary?: string;                            // min annual floor ("100000" | "150000" | "200000")
}): Promise<{ jobs: JobRow[]; total: number; page: number }> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { q, location, company, posted, sort, page, signal, visa, department, level, salary } = params;
  const from = page * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  let dbq = supabase
    .from("jobs_with_details")
    .select(
      // P1: explicit field list — visa_types excluded from payload, used only for filtering.
      "id,title,location,url,posted_at,effective_posted_at,ats_source,ats_job_id,ats_slug," +
      "company,company_domain_url,lca_count_2025,last_filing_date,confidence_tier,is_active,is_remote,salary_range,e3_lca_count," +
      "department,job_level,poc_first_name,poc_last_name,poc_email",
      { count: "planned" }
    );

  const days = POSTED_DAYS[posted];
  if (days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    // Gate on effective_posted_at (real posted_at, else first-seen scraped_at) so undated
    // list-only jobs are still ranked honestly. Backed by idx_jobs_active_effective.
    dbq = dbq.gte("effective_posted_at", cutoff);
  }

  if (q.trim()) {
    const safe = q.trim().replace(/[%_]/g, "\\$&");
    dbq = dbq.or(`title.ilike.%${safe}%,company.ilike.%${safe}%`);
  }

  if (company)                  dbq = dbq.eq("company", company);
  if (signal && signal !== "all") dbq = dbq.eq("confidence_tier", signal);

  const visaPrefix = visa && VISA_PATTERNS[visa];
  if (visaPrefix === "H-1B") {
    dbq = dbq.contains("visa_types", ["H-1B"]);
  } else if (visaPrefix === "E-3") {
    dbq = dbq.gt("e3_lca_count", 0);
  } else if (visaPrefix === "TN") {
    dbq = dbq.eq("tn_eligible", true);
  }

  if (location !== "all") {
    const patterns = LOC_PATTERNS[location];
    if (patterns) dbq = dbq.or(patterns.map((p) => `location.ilike.%${p}%`).join(","));
  }

  // Filter on the stored canonical classification (classify.py → jobs.department /
  // jobs.job_level), the single source of truth. Indexed by idx_jobs_department /
  // idx_jobs_job_level. Values match DEPARTMENT_OPTIONS / LEVEL_OPTIONS in jobs-client.
  if (department && department !== "all") {
    // Strict stored-value mapping (canonical names/labels + explicit aliases — NO keyword
    // fallback): dropdown values are real jobs.department values from department_facets(),
    // and a coined bucket like "Product Management" or "Compliance" must filter on itself.
    // toCanonicalDepartments' keyword fallback would hijack those onto Product/Legal and
    // make facet counts disagree with results. [] → filter on the literal value.
    const depts = toStoredDepartments(department);
    dbq = dbq.in("department", depts.length ? depts : [department]);
  }
  if (level && level !== "all")           dbq = dbq.eq("job_level", level);

  // Compensation floor on the parsed numeric min. Keep unknown-salary jobs visible (most
  // Workday/list-only postings have no parsed salary) per the salary-card rule, so the filter
  // narrows by known pay without hiding everything we haven't parsed yet.
  if (salary && salary !== "all") {
    const floor = parseInt(salary, 10);
    if (!Number.isNaN(floor)) {
      dbq = dbq.or(`salary_min_num.gte.${floor},salary_min_num.is.null`);
    }
  }

  dbq = dbq.order("is_active", { ascending: false });
  if (sort === "recent") {
    dbq = dbq.order("effective_posted_at", { ascending: false, nullsFirst: false });
  } else {
    dbq = dbq.order("lca_count_2025", { ascending: false });
  }

  dbq = dbq.range(from, to);

  const { data, count, error } = await dbq;
  if (error) throw new Error(error.message);

  return { jobs: (data ?? []) as unknown as JobRow[], total: count ?? 0, page };
}
