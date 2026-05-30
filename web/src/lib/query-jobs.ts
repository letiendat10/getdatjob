import { createClient } from "@supabase/supabase-js";

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

// P3: Department keywords for server-side title ILIKE filtering.
// Order matters: more-specific depts are listed before "Engineering" to avoid
// over-broad matches (e.g. "Data Engineer" should match "Data", not "Engineering").
const DEPT_PATTERNS: Record<string, string[]> = {
  "AI / ML":           ["machine learning", "ai ", " ml ", "artificial intelligence", "nlp", "llm", "research scientist", "applied scientist", " scientist"],
  "Data":              ["data engineer", "data scientist", "data analyst", "analytics", "business intelligence"],
  "Security":          ["security", "infosec", "cybersecurity", "appsec", "devsecops"],
  "Product":           ["product manager", "product owner", " pm ", "product lead"],
  "Design":            ["design", "ux ", "ui ", "designer", "user experience"],
  "Platform / DevOps": ["devops", "site reliability", "platform engineer", "infrastructure", "cloud engineer", " sre"],
  "Sales":             ["sales", "account executive", "business development"],
  "Marketing":         ["marketing", "growth marketing", "growth hacker", "demand generation"],
  "Finance":           ["finance", "accounting", "financial analyst"],
  "Facilities":        ["facilities", "mailroom", "real estate", "workplace", "janitorial", "custodial", "maintenance tech"],
  "Operations":        ["operations", " ops", "logistics", "supply chain", "fulfillment", "warehouse"],
  "Legal":             ["legal", "counsel", "attorney", "compliance", "paralegal"],
  "HR / People":       ["recruiter", "recruiting", "talent acquisition", "human resources", "hr ", "people ops", "people partner"],
  "Customer Success":  ["customer success", "customer support", "account manager", "customer experience", "cx ", "support engineer"],
  "Engineering":       ["engineer", "developer", "software", "backend", "frontend", "fullstack", "full-stack"],
};

// P3: Level keywords. "Mid-level" omitted — it's a catch-all and stays client-side.
const LEVEL_PATTERNS: Record<string, string[]> = {
  "Intern":            ["intern", "internship"],
  "Junior":            ["junior", "jr.", "entry-level", "entry level", "associate"],
  "Senior":            ["senior", "sr."],
  "Principal / Staff": ["principal", "staff engineer", "distinguished", "fellow"],
  "Lead / Manager":    ["lead", "manager", "director", "head of", " vp ", "vice president"],
};

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
  ats_source:        string;
  ats_job_id:        string;
  ats_slug:          string | null;
  company:           string;
  company_domain_url: string | null;
  lca_count_2025:    number;
  last_filing_date:  string | null;
  confidence_tier:   string | null;
  is_active:         boolean;
  salary_range:      string | null;
};

export async function queryJobs(params: {
  q: string; location: string; company: string;
  posted: string; sort: string; page: number;
  signal: string; visa: string;
  department: string; level: string;         // P3
}): Promise<{ jobs: JobRow[]; total: number; page: number }> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { q, location, company, posted, sort, page, signal, visa, department, level } = params;
  const from = page * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  let dbq = supabase
    .from("jobs_with_details")
    .select(
      // P1: explicit field list — visa_types excluded from payload, used only for filtering.
      "id,title,location,url,posted_at,ats_source,ats_job_id,ats_slug," +
      "company,company_domain_url,lca_count_2025,last_filing_date,confidence_tier,is_active,salary_range",
      { count: "planned" }
    );

  const days = POSTED_DAYS[posted];
  if (days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    dbq = dbq.or(`posted_at.gte.${cutoff},posted_at.is.null`);
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

  // P3: Server-side department filter
  if (department && department !== "all") {
    const dPatterns = DEPT_PATTERNS[department];
    if (dPatterns?.length) {
      dbq = dbq.or(dPatterns.map((p) => `title.ilike.%${p}%`).join(","));
    }
  }

  // P3: Server-side level filter ("Mid-level" stays client-side — it's a catch-all)
  if (level && level !== "all" && level !== "Mid-level") {
    const lPatterns = LEVEL_PATTERNS[level];
    if (lPatterns?.length) {
      dbq = dbq.or(lPatterns.map((p) => `title.ilike.%${p}%`).join(","));
    }
  }

  dbq = dbq.order("is_active", { ascending: false });
  if (sort === "recent") {
    dbq = dbq.order("posted_at", { ascending: false, nullsFirst: false });
  } else {
    dbq = dbq.order("lca_count_2025", { ascending: false });
  }

  dbq = dbq.range(from, to);

  const { data, count, error } = await dbq;
  if (error) throw new Error(error.message);

  return { jobs: (data ?? []) as unknown as JobRow[], total: count ?? 0, page };
}
