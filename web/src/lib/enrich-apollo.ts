// Enrichment pipeline: SerpAPI (LinkedIn URL discovery) → ScrapingDog (full profile).
// PDL and Apollo have been removed — ScrapingDog is the sole enrichment source.
//
// After ScrapingDog writes headline + location + work history to linkedin.profiles,
// we derive job_function / job_level from the headline and call enrich_set_result.
//
// Called via after() in auth/linkedin/callback — fires after the redirect.
//
// Env vars:
//   SERP_API_KEY        — SerpAPI (https://serpapi.com) for LinkedIn URL discovery
//   SCRAPINGDOG_API_KEY — ScrapingDog (https://scrapingdog.com) for profile scraping

import { createSupabaseAdmin } from "./supabase-admin";

const SERP_API_URL = "https://serpapi.com/search";

// ── Job function / level mappings ────────────────────────────────────────────
// Applied to the full lowercase headline string (not just a single role keyword).

const FUNCTION_MAP: [string, string][] = [
  // Engineering
  ["software",          "Engineering"],
  ["engineer",          "Engineering"],
  ["engineering",       "Engineering"],
  ["developer",         "Engineering"],
  ["devops",            "Engineering"],
  ["frontend",          "Engineering"],
  ["backend",           "Engineering"],
  ["fullstack",         "Engineering"],
  ["mobile",            "Engineering"],
  ["infrastructure",    "Engineering"],
  ["security",          "Engineering"],
  // Product
  ["product manager",   "Product"],
  ["product management","Product"],
  ["product",           "Product"],
  // Design
  ["design",            "Design"],
  ["ux",                "Design"],
  ["ui ",               "Design"],
  // Data / Research
  ["machine learning",  "Data"],
  ["data scientist",    "Data"],
  ["data engineer",     "Data"],
  ["data science",      "Data"],
  ["data analyst",      "Data"],
  ["analytics",         "Data"],
  ["research",          "Data"],
  // Marketing
  ["growth",            "Marketing"],
  ["marketing",         "Marketing"],
  ["brand",             "Marketing"],
  ["content",           "Marketing"],
  ["seo",               "Marketing"],
  ["demand generation", "Marketing"],
  // Sales / Business Development
  ["partnerships",      "Sales"],
  ["business development","Sales"],
  ["account executive", "Sales"],
  ["account manager",   "Sales"],
  ["sales",             "Sales"],
  ["revenue",           "Sales"],
  // Finance
  ["finance",           "Finance"],
  ["financial",         "Finance"],
  ["accounting",        "Finance"],
  ["controller",        "Finance"],
  // Operations / HR
  ["operations",        "Operations"],
  ["human resources",   "Operations"],
  ["recruiting",        "Operations"],
  ["talent",            "Operations"],
  ["hr",                "Operations"],
  ["supply chain",      "Operations"],
  ["program manager",   "Operations"],
  ["project manager",   "Operations"],
];

// Words in a headline that imply a manager/leadership level.
const MANAGER_HEADLINE_KEYWORDS = [
  "head of", "chief", "ceo", "cto", "coo", "cfo", "cpo", "cmo",
  "vp ", "vice president", "director", "manager", "principal",
  "partner", "owner", "founder", "president", "lead ",
];

function deriveJobFunction(headline: string): string {
  const h = headline.toLowerCase();
  for (const [keyword, fn] of FUNCTION_MAP) {
    if (h.includes(keyword)) return fn;
  }
  return "Other";
}

function deriveJobLevel(headline: string): "Senior IC" | "Manager/Lead" {
  const h = headline.toLowerCase();
  return MANAGER_HEADLINE_KEYWORDS.some(k => h.includes(k)) ? "Manager/Lead" : "Senior IC";
}

// ── SerpAPI — LinkedIn URL discovery ────────────────────────────────────────

type SerpResult = {
  url:      string;
  headline: string | null; // extracted from Google result title, e.g. "Growth Marketer at Caffeine"
};

// Google formats LinkedIn results as "Name - Title | LinkedIn" or
// "Name - Title at Company | LinkedIn".  Extract the title portion.
function extractSerpHeadline(serpTitle: string): string | null {
  const match = serpTitle.match(/ - (.+?) \| LinkedIn/i);
  return match?.[1]?.trim() || null;
}

async function trySerpAPI(
  fullName: string,
  email:    string | null,
  country:  string | null,
): Promise<SerpResult | null> {
  const apiKey = process.env.SERP_API_KEY;
  if (!apiKey) return null;

  // Query: "linkedin [full name] [email] [country]" mirrors a manual Google search.
  // Fetch 10 results and score each /in/ URL against the email local part —
  // email usernames often embed the LinkedIn slug (e.g. le.tiendat10 → letiendat10).
  const parts = ["linkedin", fullName, email, country].filter(Boolean);
  const q = parts.join(" ");

  // Normalise email local part: strip dots, lowercase
  const emailLocal = email ? email.split("@")[0].replace(/\./g, "").toLowerCase() : "";
  const emailLocalNoNumbers = emailLocal.replace(/\d+/g, "");

  function scoreSlug(url: string): number {
    const slug = url.split("/in/")[1]?.split(/[/?#]/)[0]?.toLowerCase() ?? "";
    if (!slug) return -1;
    if (emailLocal && slug === emailLocal) return 3;
    if (emailLocal && slug.includes(emailLocal)) return 2;
    if (emailLocalNoNumbers && slug.includes(emailLocalNoNumbers)) return 1;
    return 0;
  }

  try {
    const res = await fetch(
      `${SERP_API_URL}?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${apiKey}`,
      { signal: AbortSignal.timeout(8000) },
    );

    if (!res.ok) {
      const body = await res.text();
      console.error(`[serp] ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const data = await res.json() as { organic_results?: { link: string; title?: string }[] };
    const candidates = (data.organic_results ?? [])
      .filter(r => !!r.link?.includes("linkedin.com/in/") && !r.link.includes("/pub/dir/"));

    if (!candidates.length) {
      console.log(`[serp] no /in/ candidates among ${data.organic_results?.length ?? 0} results`);
      return null;
    }

    const scored = candidates.map(r => ({ r, s: scoreSlug(r.link) })).sort((a, b) => b.s - a.s);
    const best = scored[0].s > 0 ? scored[0].r : candidates[0];

    const headline = extractSerpHeadline(best.title ?? "");
    console.log(`[serp] resolved (score ${scored[0].s}): ${best.link}  headline="${headline}"`);
    return { url: best.link, headline };
  } catch (err) {
    console.error("[serp] fetch error:", err);
    return null;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function enrichUser(
  userId:      string,
  email:       string | null,
  firstName:   string | null,
  lastName:    string | null,
  linkedinUrl: string | null,
  locale?:     string | null,
): Promise<void> {
  const supabase = createSupabaseAdmin();

  // Step 1 — Discover LinkedIn URL via SerpAPI if not already known
  let resolvedUrl = linkedinUrl;
  if (!resolvedUrl) {
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (fullName) {
      const country = locale ? (locale.split("_")[1] ?? null) : null;
      const serpResult = await trySerpAPI(fullName, email, country);
      if (serpResult) {
        resolvedUrl = serpResult.url;

        // Write URL + SERP-extracted headline immediately (~3-5s after OAuth).
        // This is a fast approximation — the extension overwrites with the full
        // DOM-scraped headline + location ~20s later.  But having the headline
        // now means Q4 ("Senior IC or lead?") on /kai-first can pre-fill itself
        // from the title without waiting for the extension.
        const profilePatch: Record<string, string> = { linkedin_url: resolvedUrl };
        if (serpResult.headline) profilePatch.headline = serpResult.headline;

        await supabase
          .schema("linkedin")
          .from("profiles")
          .update(profilePatch)
          .eq("id", userId);

        if (serpResult.headline) {
          console.log(`[enrich] ${userId} — SERP headline written: "${serpResult.headline}"`);
        }
      }
    }
  }

  if (!resolvedUrl) {
    console.warn(`[enrich] ${userId} — no LinkedIn URL found, marking failed`);
    await supabase.rpc("enrich_set_failed", { p_user_id: userId });
    return;
  }

  // Step 2 — Queue for Chrome Extension to scrape via real browser DOM.
  // The extension polls linkedin_import_queue every 30s, opens the LinkedIn page,
  // extracts headline/location/work history, and POSTs to /api/import-linkedin/from-dom.
  const { error: queueErr } = await supabase
    .from("linkedin_import_queue")
    .insert({ user_id: userId, linkedin_url: resolvedUrl });

  if (queueErr) {
    console.error(`[enrich] ${userId} — queue insert failed:`, queueErr);
    await supabase.rpc("enrich_set_failed", { p_user_id: userId });
  } else {
    console.log(`[enrich] ${userId} — queued for Chrome extension: ${resolvedUrl}`);
    // Leave enrich_status as "pending" — the extension will call enrich_set_result when done
  }
}
