// P4: Combined first-load endpoint — returns jobs + meta in one request,
// eliminating the parallel meta fetch on initial page load.
// Only called once (on first mount with default params). Filter changes
// use /api/jobs directly (meta already in client state).

import { queryJobs } from "@/lib/query-jobs";
import { loadMeta }   from "@/lib/load-meta";
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
    const [jobsData, metaData] = await Promise.all([queryJobs(params), loadMeta()]);
    return Response.json(
      { ...jobsData, ...metaData },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
        },
      }
    );
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
