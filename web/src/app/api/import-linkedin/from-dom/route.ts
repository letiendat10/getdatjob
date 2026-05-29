// Receives DOM-extracted LinkedIn data from the Chrome extension
// and writes it to linkedin.profiles + user_work_history.
// Protected by x-import-secret header (set LINKEDIN_DOM_SECRET in env).

import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type Experience = {
  title:      string;
  company:    string;
  start_date: string | null;
  end_date:   string | null;
  is_current: boolean;
};

type DomData = {
  fullName:    string | null;
  headline:    string | null;
  location:    string | null;
  experiences: Experience[];
};

// ── Job function derivation (mirrors enrich-apollo.ts) ───────────────────────

const FUNCTION_MAP: [string, string][] = [
  ["software",           "Engineering"], ["engineer",         "Engineering"],
  ["engineering",        "Engineering"], ["developer",        "Engineering"],
  ["devops",             "Engineering"], ["infrastructure",   "Engineering"],
  ["product manager",    "Product"],     ["product",          "Product"],
  ["design",             "Design"],      ["ux",               "Design"],
  ["machine learning",   "Data"],        ["data scientist",   "Data"],
  ["data engineer",      "Data"],        ["analytics",        "Data"],
  ["research",           "Data"],
  ["growth",             "Marketing"],   ["marketing",        "Marketing"],
  ["brand",              "Marketing"],   ["content",          "Marketing"],
  ["partnerships",       "Sales"],       ["business development", "Sales"],
  ["account executive",  "Sales"],       ["sales",            "Sales"],
  ["revenue",            "Sales"],
  ["finance",            "Finance"],     ["accounting",       "Finance"],
  ["operations",         "Operations"],  ["recruiting",       "Operations"],
  ["talent",             "Operations"],  ["hr",               "Operations"],
];

const MANAGER_KEYWORDS = [
  "head of", "chief", "ceo", "cto", "coo", "cfo", "cpo", "cmo",
  "vp ", "vice president", "director", "manager", "principal",
  "partner", "owner", "founder", "president", "lead ",
];

function deriveJobFunction(title: string): string {
  const t = title.toLowerCase();
  for (const [kw, fn] of FUNCTION_MAP) { if (t.includes(kw)) return fn; }
  return "Other";
}

function deriveJobLevel(title: string): "Senior IC" | "Manager/Lead" {
  const t = title.toLowerCase();
  return MANAGER_KEYWORDS.some(k => t.includes(k)) ? "Manager/Lead" : "Senior IC";
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-import-secret");
  const expected = process.env.LINKEDIN_DOM_SECRET ?? "linkedin-dom-import-v1";
  if (secret !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { userId?: string; linkedinUrl?: string; data?: DomData };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const { userId, linkedinUrl, data } = body;
  if (!userId || !data) {
    return Response.json({ error: "userId and data required" }, { status: 400 });
  }

  const supabase = createSupabaseAdmin();

  // 1. Write to linkedin.profiles
  const headline = data.headline?.trim() || null;

  // Reject single-word location values — these are almost always company names
  // (e.g. "Caffeine", "Google") not cities. Real locations are multi-word or "Remote".
  const location = (() => {
    const raw = data.location?.trim() || null;
    if (!raw) return null;
    if (!raw.includes(" ") && !/^remote$/i.test(raw)) return null;
    return raw;
  })();

  // Headline fallback: build from current experience if blank
  let resolvedHeadline = headline;
  if (!resolvedHeadline && data.experiences.length > 0) {
    const cur = data.experiences.find(e => e.is_current) ?? data.experiences[0];
    if (cur.title && cur.title !== "Unknown") {
      resolvedHeadline = cur.company !== "Unknown"
        ? `${cur.title} at ${cur.company}`
        : cur.title;
    }
  }

  const { error: profileErr } = await supabase
    .schema("linkedin")
    .from("profiles")
    .upsert(
      {
        id:                   userId,
        ...(linkedinUrl        && { linkedin_url: linkedinUrl }),
        ...(data.fullName      && { full_name:    data.fullName }),
        ...(resolvedHeadline   && { headline:     resolvedHeadline }),
        ...(location           && { location }),
        linkedin_data_source:  "dom",
        linkedin_imported_at:  new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (profileErr) {
    console.error("[from-dom] profile upsert error:", profileErr);
    return Response.json({ error: profileErr.message }, { status: 500 });
  }

  // 2. Write work history
  if (data.experiences.length > 0) {
    await supabase.from("user_work_history").delete().eq("user_id", userId);
    const rows = data.experiences.map(e => ({
      user_id:    userId,
      title:      e.title,
      company:    e.company,
      start_date: e.start_date,
      end_date:   e.end_date,
      is_current: e.is_current,
    }));
    const { error: histErr } = await supabase.from("user_work_history").insert(rows);
    if (histErr) console.error("[from-dom] work history error:", histErr);
  }

  // 3. Derive job function + level and call enrich_set_result
  const titleForDerive = resolvedHeadline ?? "";
  const { error: enrichErr } = await supabase.rpc("enrich_set_result", {
    p_user_id:       userId,
    p_location:      location,
    p_current_title: resolvedHeadline ?? null,
    p_job_function:  deriveJobFunction(titleForDerive),
    p_job_level:     deriveJobLevel(titleForDerive),
  });
  if (enrichErr) console.error("[from-dom] enrich_set_result error:", enrichErr);

  console.log(`[from-dom] ${userId} ✓ headline="${resolvedHeadline}" location="${location}" exp=${data.experiences.length}`);

  return Response.json({
    ok: true,
    headline: resolvedHeadline,
    location,
    experiences: data.experiences.length,
  });
}
