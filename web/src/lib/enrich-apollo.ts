// People Data Labs person enrichment
// Docs: https://docs.peopledatalabs.com/docs/person-enrichment-api
// Free tier: 1,000 lookups/month
// Env var: PDL_API_KEY

import { createSupabaseAdmin } from "./supabase-admin";

const PDL_ENRICH_URL = "https://api.peopledatalabs.com/v5/person/enrich";

// Maps PDL job_title_role → our job_function enum
const FUNCTION_MAP: Record<string, string> = {
  engineering: "Engineering",
  software: "Engineering",
  it: "Engineering",
  product: "Product",
  design: "Design",
  "data science": "Data",
  analytics: "Data",
  research: "Data",
  sales: "Sales",
  "business development": "Sales",
  marketing: "Marketing",
  finance: "Finance",
  accounting: "Finance",
  operations: "Operations",
  "human resources": "Operations",
  hr: "Operations",
  legal: "Other",
  education: "Other",
};

// PDL levels that map to Manager
const MANAGER_LEVELS = new Set([
  "manager",
  "director",
  "vp",
  "c_suite",
  "cxo",
  "owner",
  "partner",
]);

function mapFunction(role: string | null | undefined): string {
  const key = (role ?? "").toLowerCase();
  return FUNCTION_MAP[key] ?? "Other";
}

function mapLevel(
  levels: string[] | string | null | undefined
): "IC" | "Manager" {
  const arr = Array.isArray(levels) ? levels : levels ? [levels] : [];
  return arr.some((l) => MANAGER_LEVELS.has(l.toLowerCase()))
    ? "Manager"
    : "IC";
}

function mapLocation(
  city: string | null | undefined,
  region: string | null | undefined,
  country: string | null | undefined
): string | null {
  if (city && region) return `${city}, ${region}`;
  if (city && country) return `${city}, ${country}`;
  return city ?? null;
}

export async function enrichWithApollo(
  userId: string,
  email: string | null,
  firstName: string | null,
  lastName: string | null
): Promise<void> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) {
    console.warn("[pdl] PDL_API_KEY not set — skipping enrichment");
    return;
  }

  const supabase = createSupabaseAdmin();

  try {
    const params = new URLSearchParams({ min_likelihood: "6" });
    if (email) params.set("email", email);
    if (firstName) params.set("first_name", firstName);
    if (lastName) params.set("last_name", lastName);

    const res = await fetch(`${PDL_ENRICH_URL}?${params}`, {
      headers: {
        "X-Api-Key": apiKey,
      },
    });

    // 404 = person not found — leave as "pending" so the LinkedIn daemon can try next
    if (res.status === 404) {
      console.log(`[pdl] ${userId} — no match, leaving pending for LinkedIn daemon`);
      return;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`[pdl] ${userId} — API ${res.status}: ${text}`);
      await supabase.rpc("enrich_set_failed", { p_user_id: userId });
      return;
    }

    const data = (await res.json()) as {
      status: number;
      data?: {
        job_title?: string;
        job_title_role?: string;
        job_title_levels?: string[];
        location_name?: string;
        location_locality?: string;
        location_region?: string;
        location_country?: string;
        linkedin_url?: string;
      };
    };

    const person = data.data;
    if (!person) {
      console.log(`[pdl] ${userId} — no person data`);
      await supabase.rpc("enrich_set_failed", { p_user_id: userId });
      return;
    }

    const location =
      person.location_name ??
      mapLocation(
        person.location_locality,
        person.location_region,
        person.location_country
      );

    // Persist LinkedIn URL if discovered
    if (person.linkedin_url) {
      await supabase
        .schema("linkedin")
        .from("profiles")
        .update({ linkedin_url: `https://www.linkedin.com/in/${person.linkedin_url}` })
        .eq("id", userId);
    }

    await supabase.rpc("enrich_set_result", {
      p_user_id: userId,
      p_location: location ?? null,
      p_current_title: person.job_title ?? null,
      p_job_function: mapFunction(person.job_title_role),
      p_job_level: mapLevel(person.job_title_levels),
    });

    console.log(`[pdl] ${userId} — done`, {
      title: person.job_title,
      location,
      fn: mapFunction(person.job_title_role),
      level: mapLevel(person.job_title_levels),
    });
  } catch (err) {
    console.error(`[pdl] ${userId} — unexpected error:`, err);
    await supabase.rpc("enrich_set_failed", { p_user_id: userId });
  }
}
