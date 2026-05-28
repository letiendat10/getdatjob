// LinkedIn profile import via ScrapingDog Person Profile Scraper.
// Drop-in replacement for enrich-proxycurl — same ImportResult type.
//
// Env vars:
//   SCRAPINGDOG_API_KEY — get one at https://www.scrapingdog.com/dashboard
//
// Credit cost: 50 credits public / 100 credits protected profile.
// premium=true is required — without it ScrapingDog returns a generic error.
// Endpoint: GET https://api.scrapingdog.com/profile/?api_key=KEY&type=profile&id=SLUG&premium=true

import { createSupabaseAdmin } from "./supabase-admin";

const SCRAPINGDOG_URL = "https://api.scrapingdog.com/profile/";

const LINKEDIN_URL_RE =
  /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_%\-À-￿]+)\/?(?:\?.*)?$/;

export function isValidLinkedInUrl(url: string): boolean {
  return LINKEDIN_URL_RE.test(url.trim());
}

export function normalizeLinkedInUrl(url: string): string {
  const trimmed = url.trim().replace(/\?.*$/, "").replace(/\/$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function extractSlug(url: string): string | null {
  const m = url.match(LINKEDIN_URL_RE);
  return m ? m[1] : null;
}

// ── Response normalization (based on observed ScrapingDog response shape) ──
// Actual field names confirmed from live API:
//   fullName, first_name, last_name, profile_photo, headline, about, location
//   experience[].position, company_name, starts_at, ends_at, summary, location

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function pick(obj: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickArr(obj: Raw, ...keys: string[]): unknown[] {
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) return obj[k];
  }
  return [];
}

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Parses ScrapingDog date strings: "Jan 1968", "Feb 2020", "2020-06", "2020"
// Returns "YYYY-MM-DD" or null.
function normalizeDate(raw: Raw | string | null | undefined): string | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    if (raw === "Present") return null;
    // "Jan 1968" or "January 1968"
    const mdy = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (mdy) {
      const mon = MONTH_MAP[mdy[1].slice(0, 3).toLowerCase()] ?? "01";
      return `${mdy[2]}-${mon}-01`;
    }
    // ISO-ish: "2020-06" or "2020-06-15"
    const iso = raw.match(/^(\d{4}-\d{2}(?:-\d{2})?)/);
    if (iso) return iso[1].length === 7 ? `${iso[1]}-01` : iso[1];
    // bare year
    const yr = raw.match(/^(\d{4})$/);
    if (yr) return `${yr[1]}-01-01`;
    return null;
  }
  // object with year/month/day (Proxycurl-style, kept for compatibility)
  const year = raw.year ?? raw.Year;
  if (!year) return null;
  const month = String(raw.month ?? raw.Month ?? 1).padStart(2, "0");
  const day = String(raw.day ?? raw.Day ?? 1).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cleanCompanyName(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  // ScrapingDog sometimes returns "Position\n   Company" concatenated
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  // Last non-empty segment is typically the company name
  return lines[lines.length - 1] ?? raw.trim();
}

function normalizeExperience(raw: Raw): {
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
} {
  const endsAtRaw = raw.ends_at ?? raw.end_date ?? raw.endDate ?? raw.end ?? raw.to;
  const isCurrent =
    !endsAtRaw || endsAtRaw === "Present" || endsAtRaw === "present";

  return {
    company: cleanCompanyName(
      pick(raw, "company_name", "company", "companyName", "organization")
    ),
    title:
      pick(raw, "position", "title", "role", "jobTitle", "job_title", "designation") ??
      "Unknown",
    location: pick(raw, "location", "geo", "city") ?? null,
    start_date: normalizeDate(
      raw.starts_at ?? raw.start_date ?? raw.startDate ?? raw.start ?? raw.from
    ),
    end_date: isCurrent ? null : normalizeDate(endsAtRaw),
    is_current: isCurrent,
  };
}

function normalizeEducation(raw: Raw): {
  school: string | null;
  degree: string | null;
  field_of_study: string | null;
  start_date: string | null;
  end_date: string | null;
} {
  return {
    school: pick(raw, "school", "schoolName", "institution", "college") ?? null,
    degree: pick(raw, "degree", "degreeName", "degree_name", "qualification") ?? null,
    field_of_study: pick(raw, "field_of_study", "fieldOfStudy", "field", "major") ?? null,
    start_date: normalizeDate(
      raw.starts_at ?? raw.start_date ?? raw.startDate ?? raw.start ?? raw.from
    ),
    end_date: normalizeDate(
      raw.ends_at ?? raw.end_date ?? raw.endDate ?? raw.end ?? raw.to
    ),
  };
}

function normalizeSkills(raw: Raw): string[] {
  const arr = pickArr(raw, "skills", "skill_list", "skillList");
  return arr
    .map((s) =>
      typeof s === "string" ? s : (s as Raw).name ?? (s as Raw).skill ?? null
    )
    .filter((s): s is string => !!s);
}

function normalizeProfile(data: Raw): {
  full_name: string | null;
  first_name: string | null;
  avatar_url: string | null;
  headline: string | null;
  summary: string | null;
  location: string | null;
  skills: string[];
  education: ReturnType<typeof normalizeEducation>[];
  experiences: ReturnType<typeof normalizeExperience>[];
} {
  const firstName = pick(data, "first_name", "firstName", "first");
  const lastName = pick(data, "last_name", "lastName", "last");
  const full =
    pick(data, "fullName", "full_name", "name") ??
    (firstName && lastName ? `${firstName} ${lastName}` : firstName ?? lastName);

  const locationRaw = pick(data, "location", "geo", "geoLocation", "address");
  // ScrapingDog sometimes returns social counts in the location field; skip those
  const location =
    locationRaw && !/follower|connection|introduce/i.test(locationRaw)
      ? locationRaw
      : null;

  const experienceRaw = pickArr(
    data,
    "experience",
    "experiences",
    "positions",
    "work_history",
    "workHistory"
  ) as Raw[];

  const educationRaw = pickArr(
    data,
    "education",
    "educations",
    "education_list"
  ) as Raw[];

  return {
    full_name: full,
    first_name: firstName,
    avatar_url: pick(
      data,
      "profile_photo",
      "profile_pic_url",
      "profilePicUrl",
      "picture",
      "avatar",
      "image",
      "photo"
    ),
    headline: pick(data, "headline", "title", "occupation", "currentTitle"),
    summary: pick(data, "about", "summary", "description", "bio"),
    location,
    skills: normalizeSkills(data),
    education: educationRaw.map(normalizeEducation),
    experiences: experienceRaw.map(normalizeExperience),
  };
}

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
  const slug = extractSlug(url);
  if (!slug) return { status: "invalid_url" };

  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "SCRAPINGDOG_API_KEY not configured" };
  }

  const qs = new URLSearchParams({
    api_key: apiKey,
    type: "profile",
    id: slug,
    premium: "true",
  });

  let res: Response;
  try {
    res = await fetch(`${SCRAPINGDOG_URL}?${qs}`, {
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "fetch failed",
    };
  }

  if (res.status === 404) return { status: "not_found" };
  if (res.status === 429 || res.status === 503) return { status: "rate_limited" };
  if (res.status === 202) {
    return { status: "error", message: "ScrapingDog returned 202 (async); retry shortly." };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "error",
      message: `ScrapingDog ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  let raw: Raw;
  try {
    raw = (await res.json()) as Raw;
  } catch {
    return { status: "error", message: "ScrapingDog returned non-JSON response" };
  }

  // success=false envelope means the profile wasn't found / scrape failed
  if (raw.success === false) return { status: "not_found" };
  if (!raw || typeof raw !== "object" || Object.keys(raw).length < 3) {
    return { status: "not_found" };
  }

  const profile = normalizeProfile(raw);

  const supabase = createSupabaseAdmin();

  const { error: profileError } = await supabase
    .schema("linkedin")
    .from("profiles")
    .upsert(
      {
        id: userId,
        linkedin_url: url,
        full_name: profile.full_name,
        first_name: profile.first_name,
        avatar_url: profile.avatar_url,
        headline: profile.headline,
        summary: profile.summary,
        location: profile.location,
        skills: profile.skills,
        education: profile.education,
        linkedin_data_raw: raw,
        linkedin_data_source: "scrapingdog",
        linkedin_imported_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (profileError) {
    return { status: "error", message: profileError.message };
  }

  await supabase.from("user_work_history").delete().eq("user_id", userId);

  const positions = profile.experiences.map((exp) => ({
    user_id: userId,
    company: exp.company,
    title: exp.title,
    location: exp.location,
    start_date: exp.start_date,
    end_date: exp.end_date,
    is_current: exp.is_current,
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
      location: profile.location,
      positions_count: positions.length,
    },
  };
}
