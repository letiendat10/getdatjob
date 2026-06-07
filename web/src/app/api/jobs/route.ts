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
    salary:     sp.get("salary")     ?? "all",
  };

  try {
    const data = await queryJobs(params);
    return Response.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
      },
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
