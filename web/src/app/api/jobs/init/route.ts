// P4: Combined first-load endpoint — originally returned jobs + meta in one request.
// P2 update (2026-05-25): meta stripped out. The init endpoint now returns only
// jobs, so the critical-path response is as small/fast as queryJobs alone.
// The client fetches /api/jobs/meta lazily on filter-bar interaction (or via
// requestIdleCallback as a backstop). See web/src/app/jobs/jobs-client.tsx.
//
// Kept the /init route name (vs. just using /api/jobs) so the layout's
// <link rel="preload"> hint still has a stable URL to prime, and so cold-Lambda
// vs warm-CDN paths can be monitored independently in perf-logs/measure.sh.

import { queryJobs } from "@/lib/query-jobs";
import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const params = {
    q:          sp.get("q")          ?? "",
    location:   sp.get("location")   ?? "all",
    company:    sp.get("company")    ?? "",
    posted:     sp.get("posted")     ?? "7d",
    sort:       sp.get("sort")       ?? "recent",
    page:       Math.max(0, parseInt(sp.get("page") ?? "0", 10)),
    signal:     sp.get("signal")     ?? "all",
    visa:       sp.get("visa")       ?? "H1B",
    department: sp.get("department") ?? "all",
    level:      sp.get("level")      ?? "all",
  };

  try {
    const jobsData = await queryJobs(params);
    return Response.json(jobsData, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
      },
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
