// Orthogonal → ContactOut /v1/linkedin/enrich — fast, headless enrichment from
// a LinkedIn URL. Replaces the 16s Chrome extension scrape with one ~3s server
// call returning headline + location + company.
//
// Strategy chosen after Phase-1 spike (n=5 personal-Gmail cohort):
//   See /Users/dat/.claude/plans/you-are-the-principal-snoopy-treasure.md and
//   /Users/dat/getdatjob/scripts/orthogonal_vs_current.md for the comparison.
//   ContactOut /v1/people/enrich proved unreliable under concurrent load and
//   costs 55x more — never use it.
//
// Env: ORTHOGONAL_API_KEY (https://orthogonal.com — pooled-credential gateway)

const ORTH_RUN_URL = "https://api.orthogonal.com/v1/run";

export type OrthogonalProfile = {
  url:      string;
  headline: string | null;
  location: string | null;
  company:  string | null;
  priceCents: number | null;
};

export async function enrichByLinkedInUrl(
  url: string,
  timeoutMs = 6000,
): Promise<OrthogonalProfile | null> {
  const apiKey = process.env.ORTHOGONAL_API_KEY;
  if (!apiKey) {
    console.warn("[orthogonal] ORTHOGONAL_API_KEY missing — skipping");
    return null;
  }

  try {
    const res = await fetch(ORTH_RUN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api: "contactout",
        path: "/v1/linkedin/enrich",
        query: { profile: url, profile_only: "true" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error(`[orthogonal] HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      success?: boolean;
      priceCents?: number;
      data?: {
        profile?: {
          url?: string;
          headline?: string | null;
          location?: string | null;
          company?: { name?: string | null } | null;
        };
      };
    };

    if (!json.success) {
      console.warn("[orthogonal] success=false");
      return null;
    }

    const p = json.data?.profile;
    if (!p?.headline) {
      console.warn("[orthogonal] empty profile.headline — counts as miss");
      return null;
    }

    return {
      url:      p.url ?? url,
      headline: p.headline ?? null,
      location: p.location ?? null,
      company:  p.company?.name ?? null,
      priceCents: json.priceCents ?? null,
    };
  } catch (err) {
    console.error("[orthogonal] fetch error:", err);
    return null;
  }
}

// ── Job function / level derivation (mirrors enrich-apollo.ts + from-dom/route.ts) ──

const FUNCTION_MAP: [string, string][] = [
  ["software",          "Engineering"], ["engineer",         "Engineering"],
  ["engineering",       "Engineering"], ["developer",        "Engineering"],
  ["devops",            "Engineering"], ["infrastructure",   "Engineering"],
  ["product manager",   "Product"],     ["product",          "Product"],
  ["design",            "Design"],      ["ux",               "Design"],
  ["machine learning",  "Data"],        ["data scientist",   "Data"],
  ["data engineer",     "Data"],        ["analytics",        "Data"],
  ["research",          "Data"],
  ["growth",            "Marketing"],   ["marketing",        "Marketing"],
  ["brand",             "Marketing"],   ["content",          "Marketing"],
  ["partnerships",      "Sales"],       ["business development", "Sales"],
  ["account executive", "Sales"],       ["sales",            "Sales"],
  ["revenue",           "Sales"],
  ["finance",           "Finance"],     ["accounting",       "Finance"],
  ["operations",        "Operations"],  ["recruiting",       "Operations"],
  ["talent",            "Operations"],  ["hr",               "Operations"],
];

// DB constraint `profiles_job_level_check` requires one of:
// Junior | Lead | Senior | Principal | Staff | People Manager
const MANAGER_KEYWORDS = [
  "head of", "chief ", "ceo", "cto", "coo", "cfo", "cpo", "cmo",
  "vp ", "vice president", "director", "manager",
  "founder", "president",
];

export function deriveJobFunction(headline: string): string {
  const h = headline.toLowerCase();
  for (const [kw, fn] of FUNCTION_MAP) if (h.includes(kw)) return fn;
  return "Other";
}

export type JobLevel = "Junior" | "Lead" | "Senior" | "Principal" | "Staff" | "People Manager";

export function deriveJobLevel(headline: string): JobLevel {
  const h = headline.toLowerCase();
  if (h.includes("staff ") || h.includes("staff,")) return "Staff";
  if (h.includes("principal")) return "Principal";
  if (/\b(junior|entry[- ]level|associate)\b/.test(h)) return "Junior";
  if (MANAGER_KEYWORDS.some(k => h.includes(k))) return "People Manager";
  if (/\blead\b/.test(h) && !h.includes("lead generation")) return "Lead";
  return "Senior";
}
