// LinkedIn profile import via Proxycurl.
// Single entry point: importLinkedInFromUrl(userId, url) — calls Proxycurl,
// writes the result into linkedin.profiles + public.user_work_history.
//
// Env vars:
//   PROXYCURL_API_KEY — get one at https://nubela.co/proxycurl/
//
// Pricing reference: ~1 credit per fresh profile lookup (~$0.01 at standard
// volume). `use_cache=if-recent` reuses Proxycurl's last successful crawl
// (cheaper) instead of re-scraping each time.

import { createSupabaseAdmin } from "./supabase-admin";

const PROXYCURL_URL = "https://nubela.co/proxycurl/api/v2/linkedin";

// Accepts: linkedin.com/in/<slug>, www.linkedin.com/in/<slug>,
// linkedin.com/in/<slug>/, with or without https://. Rejects everything else.
const LINKEDIN_URL_RE =
  /^https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_%\-À-￿]+\/?(?:\?.*)?$/;

export function isValidLinkedInUrl(url: string): boolean {
  return LINKEDIN_URL_RE.test(url.trim());
}

// Normalize so re-imports of the same profile don't create dupes.
export function normalizeLinkedInUrl(url: string): string {
  const trimmed = url.trim().replace(/\?.*$/, "").replace(/\/$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

// ── Proxycurl response shape (only the fields we use) ───────────────────────

type ProxycurlDate = { day: number; month: number; year: number } | null;

type ProxycurlExperience = {
  starts_at: ProxycurlDate;
  ends_at: ProxycurlDate;
  company: string | null;
  company_linkedin_profile_url?: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
};

type ProxycurlEducation = {
  starts_at: ProxycurlDate;
  ends_at: ProxycurlDate;
  field_of_study: string | null;
  degree_name: string | null;
  school: string | null;
  description: string | null;
};

type ProxycurlProfile = {
  public_identifier: string | null;
  profile_pic_url: string | null;
  background_cover_image_url: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  occupation: string | null; // current title
  headline: string | null;
  summary: string | null;
  country: string | null;
  city: string | null;
  state: string | null;
  experiences: ProxycurlExperience[];
  education: ProxycurlEducation[];
  skills?: string[];
};

// ── Public API ──────────────────────────────────────────────────────────────

export type ImportResult =
  | {
      status: "ok";
      profile: {
        full_name: string | null;
        headline: string | null;
        location: string | null;
        positions_count: number;
      };
    }
  | { status: "invalid_url" }
  | { status: "not_found" }
  | { status: "rate_limited" }
  | { status: "error"; message: string };

export async function importLinkedInFromUrl(
  userId: string,
  rawUrl: string
): Promise<ImportResult> {
  if (!isValidLinkedInUrl(rawUrl)) return { status: "invalid_url" };
  const url = normalizeLinkedInUrl(rawUrl);

  const apiKey = process.env.PROXYCURL_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "PROXYCURL_API_KEY not configured" };
  }

  // Fetch profile from Proxycurl
  const qs = new URLSearchParams({
    linkedin_profile_url: url,
    use_cache: "if-recent",
    fallback_to_cache: "on-error",
    skills: "include",
  });

  const res = await fetch(`${PROXYCURL_URL}?${qs}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 404) return { status: "not_found" };
  if (res.status === 429) return { status: "rate_limited" };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "error",
      message: `Proxycurl ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const profile = (await res.json()) as ProxycurlProfile;

  // Write to Supabase
  const supabase = createSupabaseAdmin();
  const location = [profile.city, profile.state, profile.country]
    .filter(Boolean)
    .join(", ") || null;

  const { error: profileError } = await supabase
    .schema("linkedin")
    .from("profiles")
    .upsert(
      {
        id: userId,
        linkedin_url: url,
        full_name: profile.full_name,
        first_name: profile.first_name,
        avatar_url: profile.profile_pic_url,
        headline: profile.headline,
        summary: profile.summary,
        location,
        skills: profile.skills ?? [],
        education: profile.education ?? [],
        raw_proxycurl: profile,
        proxycurl_imported_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (profileError) {
    return { status: "error", message: profileError.message };
  }

  // Replace work history: clear then re-insert.
  // Cheaper than per-row diffing and the user's history is small (<100 rows).
  await supabase.from("user_work_history").delete().eq("user_id", userId);

  const positions = (profile.experiences ?? []).map((exp) => ({
    user_id: userId,
    company: exp.company ?? "Unknown",
    title: exp.title ?? "Unknown",
    location: exp.location,
    start_date: dateFromProxycurl(exp.starts_at),
    end_date: dateFromProxycurl(exp.ends_at),
    is_current: exp.ends_at === null,
  }));

  if (positions.length > 0) {
    const { error: historyError } = await supabase
      .from("user_work_history")
      .insert(positions);
    if (historyError) {
      return { status: "error", message: historyError.message };
    }
  }

  return {
    status: "ok",
    profile: {
      full_name: profile.full_name,
      headline: profile.headline,
      location,
      positions_count: positions.length,
    },
  };
}

function dateFromProxycurl(d: ProxycurlDate): string | null {
  if (!d) return null;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day || 1).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}
