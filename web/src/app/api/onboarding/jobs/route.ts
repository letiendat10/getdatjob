import { NextRequest } from "next/server";
import { handleSearchJobs, countMatchingJobs3d } from "@/lib/kai-tools";

export const runtime = "nodejs";

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
    const { visa, location, locationMode, salary_min, intent, department } = body;

    const baseParams: Parameters<typeof handleSearchJobs>[0] = {};

    if (visa && visa !== "Other") baseParams.visa_category = visa;
    if (salary_min && salary_min > 0) baseParams.salary_min = salary_min;

    if (locationMode === "remote") {
      baseParams.location = "remote";
    } else if (locationMode === "local" && location) {
      baseParams.location = location;
    }
    // locationMode === "anywhere" → no location filter

    // Department from inferred LinkedIn title — soft filter, skip if missing
    if (department) baseParams.department = department;

    // Run both in parallel: 7d results for display + exact 3d count for the support popup
    const [result, total_3d_count] = await Promise.all([
      handleSearchJobs({ ...baseParams, limit: 6, posted_within: "7d" }),
      countMatchingJobs3d({
        visa_category: baseParams.visa_category,
        salary_min: baseParams.salary_min,
        location: baseParams.location,
      }),
    ]);

    return Response.json({ ...result, total_3d_count });
  } catch {
    return Response.json({ error: "Failed to fetch jobs", jobs: [] }, { status: 500 });
  }
}
