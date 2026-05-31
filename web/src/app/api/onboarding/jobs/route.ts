import { NextRequest } from "next/server";
import { handleSearchJobs, countMatchingJobsInWindow } from "@/lib/kai-tools";

export const runtime = "nodejs";

type Body = {
  visa?: string;
  location?: string;
  locationMode?: string;
  salary_min?: number;
  intent?: string;
  department?: string;
  level?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body: Body = await req.json();
    const { visa, location, locationMode, salary_min, department, level } = body;

    const baseParams: Parameters<typeof handleSearchJobs>[0] = {};

    if (visa && visa !== "Other") baseParams.visa_category = visa;
    if (salary_min && salary_min > 0) baseParams.salary_min = salary_min;

    if (locationMode === "remote") {
      baseParams.location = "remote";
    } else if (locationMode === "local" && location) {
      baseParams.location = location;
    }
    // locationMode === "anywhere" → no location filter

    if (department) baseParams.department = department;

    // Cascade: try 3d → 7d → 14d, stop at the first window with ≥5 matching jobs.
    // countMatchingJobsInWindow applies department + level filters for an accurate count.
    const WINDOWS = [3, 7, 14] as const;
    let fetchedJobs: Awaited<ReturnType<typeof handleSearchJobs>>["jobs"] = [];
    let totalCount = 0;
    let windowDays: 0 | 3 | 7 | 14 = 0;

    for (const days of WINDOWS) {
      const count = await countMatchingJobsInWindow({
        visa_category: baseParams.visa_category,
        salary_min: baseParams.salary_min,
        location: baseParams.location,
        department,
        level,
        days,
      });

      if (count >= 5) {
        const result = await handleSearchJobs({
          ...baseParams,
          limit: 5,
          posted_within: `${days}d` as "3d" | "7d" | "14d",
        });
        // Sort by most recent first
        fetchedJobs = [...result.jobs].sort((a, b) => {
          const da = a.posted_at ? new Date(a.posted_at).getTime() : 0;
          const db = b.posted_at ? new Date(b.posted_at).getTime() : 0;
          return db - da;
        });
        totalCount = count;
        windowDays = days;
        break;
      }
    }

    // Fallback: nothing hit ≥5 even in 14d — return whatever exists
    if (windowDays === 0) {
      const result = await handleSearchJobs({
        ...baseParams,
        limit: 5,
        posted_within: "14d",
      });
      fetchedJobs = [...result.jobs].sort((a, b) => {
        const da = a.posted_at ? new Date(a.posted_at).getTime() : 0;
        const db = b.posted_at ? new Date(b.posted_at).getTime() : 0;
        return db - da;
      });
    }

    return Response.json({
      jobs: fetchedJobs,
      total_count: totalCount,   // 0 when window_days === 0
      window_days: windowDays,   // 3 | 7 | 14 | 0
    });
  } catch {
    return Response.json({ error: "Failed to fetch jobs", jobs: [], total_count: 0, window_days: 0 }, { status: 500 });
  }
}
