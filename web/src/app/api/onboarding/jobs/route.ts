import { NextRequest } from "next/server";
import { handleSearchJobs } from "@/lib/kai-tools";

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

    const params: Parameters<typeof handleSearchJobs>[0] = { limit: 6 };

    if (visa && visa !== "Other") params.visa_category = visa;
    if (salary_min && salary_min > 0) params.salary_min = salary_min;
    params.posted_within = "7d";

    if (locationMode === "remote") {
      params.location = "remote";
    } else if (locationMode === "local" && location) {
      params.location = location;
    }
    // locationMode === "anywhere" → no location filter

    // Department from inferred LinkedIn title — soft filter, skip if missing
    if (department) params.department = department;

    const result = await handleSearchJobs(params);
    return Response.json(result);
  } catch {
    return Response.json({ error: "Failed to fetch jobs", jobs: [] }, { status: 500 });
  }
}
