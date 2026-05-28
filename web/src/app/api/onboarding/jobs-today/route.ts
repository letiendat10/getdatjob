import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { handleSearchJobs } from "@/lib/kai-tools";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Body = {
  visa?: string;
  location?: string;
  locationMode?: string;
  salary_min?: number;
  intent?: string;
  department?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body: Body = await req.json();
    const { visa, location, locationMode, salary_min, department } = body;

    // Build shared filter params (no limit — used for count query too)
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();

    // Count query: how many jobs from today match the user's profile?
    let countQ = supabaseAdmin
      .from("jobs_kai_view")
      .select("id", { count: "exact", head: true })
      .gte("posted_at", cutoff);

    if (visa && visa !== "Other") {
      const v = visa.toUpperCase();
      if (v === "H-1B" || v === "H1B") {
        countQ = countQ.in("visa_tier", ["verified", "friendly"]);
      } else {
        countQ = countQ.ilike("visa_class", `%${visa}%`);
      }
    }
    if (salary_min && salary_min > 0) {
      countQ = countQ.gte("salary_estimate", salary_min);
    }
    if (locationMode === "remote") {
      countQ = countQ.ilike("location", "%remote%");
    } else if (locationMode === "local" && location) {
      countQ = countQ.ilike("location", `%${location}%`);
    }

    // Top-3 jobs from the last 24h using the same scoring as handleSearchJobs
    const jobsParams: Parameters<typeof handleSearchJobs>[0] = {
      limit: 3,
      posted_within: "1d",
    };
    if (visa && visa !== "Other") jobsParams.visa_category = visa;
    if (salary_min && salary_min > 0) jobsParams.salary_min = salary_min;
    if (locationMode === "remote") {
      jobsParams.location = "remote";
    } else if (locationMode === "local" && location) {
      jobsParams.location = location;
    }
    if (department) jobsParams.department = department;

    const [countResult, jobsResult] = await Promise.all([
      countQ,
      handleSearchJobs(jobsParams),
    ]);

    const total_count = countResult.count ?? 0;

    return Response.json({ jobs: jobsResult.jobs ?? [], total_count });
  } catch {
    return Response.json({ error: "Failed to fetch jobs", jobs: [], total_count: 0 }, { status: 500 });
  }
}
