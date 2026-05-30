// Supabase Edge Function — co-located with Postgres in us-west-2.
// Mirrors web/src/lib/query-jobs.ts. Deployed via the Supabase MCP, not the CLI.
// Called from web/src/app/api/jobs/init-v2/route.ts (server-side, no JWT required).

import { createClient } from "jsr:@supabase/supabase-js@2";

const PAGE_SIZE = 30;

const POSTED_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };

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

const DEPT_PATTERNS: Record<string, string[]> = {
  "AI / ML":           ["machine learning", "ai ", " ml ", "artificial intelligence", "nlp", "llm", "research scientist"],
  "Data":              ["data engineer", "data scientist", "data analyst", "analytics", "business intelligence"],
  "Security":          ["security", "infosec", "cybersecurity", "appsec", "devsecops"],
  "Product":           ["product manager", "product owner", " pm ", "product lead"],
  "Design":            ["design", "ux ", "ui ", "designer", "user experience"],
  "Platform / DevOps": ["devops", "site reliability", "platform engineer", "infrastructure", "cloud engineer", " sre"],
  "Sales":             ["sales", "account executive", "business development"],
  "Marketing":         ["marketing", "growth", "demand generation"],
  "Finance":           ["finance", "accounting", "financial analyst"],
  "Facilities":        ["facilities", "mailroom", "real estate", "workplace", "janitorial", "custodial", "maintenance tech"],
  "Operations":        ["operations", " ops", "logistics", "supply chain", "fulfillment", "warehouse"],
  "Legal":             ["legal", "counsel", "attorney", "compliance", "paralegal"],
  "HR / People":       ["recruiter", "recruiting", "talent acquisition", "human resources", "hr ", "people ops", "people partner"],
  "Customer Success":  ["customer success", "customer support", "account manager", "customer experience", "cx ", "support engineer"],
  "Engineering":       ["engineer", "developer", "software", "backend", "frontend", "fullstack", "full-stack"],
};

const LEVEL_PATTERNS: Record<string, string[]> = {
  "Intern":            ["intern", "internship"],
  "Junior":            ["junior", "jr.", "entry-level", "entry level", "associate"],
  "Senior":            ["senior", "sr."],
  "Principal / Staff": ["principal", "staff engineer", "distinguished", "fellow"],
  "Lead / Manager":    ["lead", "manager", "director", "head of", " vp ", "vice president"],
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const q          = sp.get("q")          ?? "";
  const location   = sp.get("location")   ?? "all";
  const company    = sp.get("company")    ?? "";
  const posted     = sp.get("posted")     ?? "7d";
  const sort       = sp.get("sort")       ?? "recent";
  const page       = Math.max(0, parseInt(sp.get("page") ?? "0", 10));
  const signal     = sp.get("signal")     ?? "all";
  const visa       = sp.get("visa")       ?? "H1B";
  const department = sp.get("department") ?? "all";
  const level      = sp.get("level")      ?? "all";

  const from = page * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    let dbq = supabase
      .from("jobs_with_details")
      .select(
        "id,title,location,url,posted_at,ats_source,ats_job_id,ats_slug," +
        "company,company_domain_url,lca_count_2025,last_filing_date,confidence_tier,is_active,salary_range",
        { count: "planned" },
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

    if (company)                    dbq = dbq.eq("company", company);
    if (signal && signal !== "all") dbq = dbq.eq("confidence_tier", signal);

    const visaPrefix = visa && VISA_PATTERNS[visa];
    if (visaPrefix === "H-1B") {
      dbq = dbq.contains("visa_types", ["H-1B"]);
    } else if (visaPrefix === "E-3") {
      dbq = dbq.gt("e3_lca_count", 0);
    } else if (visaPrefix === "TN") {
      dbq = dbq.gt("tn_lca_count", 0);
    }

    if (location !== "all") {
      const patterns = LOC_PATTERNS[location];
      if (patterns) dbq = dbq.or(patterns.map((p) => `location.ilike.%${p}%`).join(","));
    }

    if (department && department !== "all") {
      const dPatterns = DEPT_PATTERNS[department];
      if (dPatterns?.length) {
        dbq = dbq.or(dPatterns.map((p) => `title.ilike.%${p}%`).join(","));
      }
    }

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

    return new Response(
      JSON.stringify({ jobs: data ?? [], total: count ?? 0, page }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
        },
      },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
